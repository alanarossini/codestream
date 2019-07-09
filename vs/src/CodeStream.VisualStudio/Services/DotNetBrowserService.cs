﻿using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel.Composition;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Resources;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using CodeStream.VisualStudio.Commands;
using CodeStream.VisualStudio.Core.Logging;
using CodeStream.VisualStudio.Events;
using CodeStream.VisualStudio.Extensions;
using CodeStream.VisualStudio.Models;
using CodeStream.VisualStudio.UI.Wpf;
using DotNetBrowser;
using DotNetBrowser.Events;
using DotNetBrowser.WPF;
using Microsoft.VisualStudio.Shell;
using Newtonsoft.Json.Linq;
using Serilog;
using static CodeStream.VisualStudio.Extensions.FileSystemExtensions;

namespace CodeStream.VisualStudio.Services {
	/// <summary>
	/// This class handles communication between javascript and .NET
	/// </summary>
	public class PostMessageInterop {
		public void Handle(string message) {
			if (MessageHandler == null) return;

			_ = MessageHandler(this, new WindowEventArgs(message));
		}

		public static WindowMessageHandler MessageHandler;
	}

	public interface IBrowserServiceFactory {
		IBrowserService Create();
	}

	[Export(typeof(IBrowserServiceFactory))]
	[PartCreationPolicy(CreationPolicy.Shared)]
	public class BrowserServiceFactory : ServiceFactory<IBrowserService>, IBrowserServiceFactory {
		[ImportingConstructor]
		public BrowserServiceFactory([Import(typeof(SVsServiceProvider))] IServiceProvider serviceProvider) :
			base(serviceProvider) {
		}
	}

	/// <summary>
	/// Implementation of a browser service using DotNetBrowser
	/// </summary>
	[Export(typeof(IBrowserService))]
	[PartCreationPolicy(CreationPolicy.Shared)]
	public class DotNetBrowserService : IBrowserService, IDisposable, DialogHandler, LoadHandler, ResourceHandler {
		private static readonly ILogger Log = LogManager.ForContext<IBrowserService>();

		private readonly BlockingCollection<string> _messageQueue;

		/// <summary>
		/// 99, not 100, because we are checking inside the processor which was already dequeued one
		/// </summary>
		private const int QueueLimit = 99;

		private WPFBrowserView _browserView;
		private BrowserContext _browserContext;
		private string _path;

		private readonly IDisposable _sessionReadyEvent;
		private readonly IDisposable _sessionLogoutEvent;

		private readonly ManualResetEvent _manualResetEvent;
		private readonly CancellationTokenSource _processorTokenSource;
		private CancellationTokenSource _queueTokenSource;
		private static System.Threading.Tasks.Task _processor;

		/// <summary>
		/// This handles what is passed into DotNetBrowser as well as which Chromium switches get created
		/// </summary>
		public BrowserType BrowserType => BrowserType.HEAVYWEIGHT;
		public int QueueCount => _messageQueue.Count;

		private readonly ICodeStreamAgentServiceFactory _codeStreamAgentServiceFactory;
		private readonly IEventAggregator _eventAggregator;		

		[ImportingConstructor]
		public DotNetBrowserService(ICodeStreamAgentServiceFactory codeStreamAgentServiceFactory,
				IEventAggregator eventAggregator) {
			_codeStreamAgentServiceFactory = codeStreamAgentServiceFactory;
			_eventAggregator = eventAggregator;
			
			try {
				_messageQueue = new BlockingCollection<string>(new ConcurrentQueue<string>());
				_manualResetEvent = new ManualResetEvent(false);
				_sessionReadyEvent = _eventAggregator.GetEvent<SessionReadyEvent>().Subscribe(_ => {
					Log.Debug($"{nameof(SessionReadyEvent)} Message QueueCount={QueueCount}");
					_manualResetEvent.Set();
				});
				_sessionLogoutEvent = _eventAggregator.GetEvent<SessionLogoutEvent>().Subscribe(_ => {
					Log.Debug($"{nameof(SessionLogoutEvent)} Message QueueCount={QueueCount}");
					_queueTokenSource?.Cancel();
					_messageQueue.Clear();
					_manualResetEvent.Reset();
				});
				//https://stackoverflow.com/questions/9106419/how-to-cancel-getconsumingenumerable-on-blockingcollection
				_processorTokenSource = new CancellationTokenSource();
				var processorToken = _processorTokenSource.Token;

				_processor = System.Threading.Tasks.Task.Factory.StartNew(() => {
					try {
						while (_manualResetEvent.WaitOne()) {
							if (processorToken.IsCancellationRequested) {
								break;
							}

							_queueTokenSource = new CancellationTokenSource();
							var queueToken = _queueTokenSource.Token;
							try {
								foreach (var value in _messageQueue.GetConsumingEnumerable(_queueTokenSource.Token)) {
									if (queueToken.IsCancellationRequested) {
										break;
									}

									if (_messageQueue.Count > QueueLimit) {
										_messageQueue.Clear();
										_manualResetEvent.Reset();
#pragma warning disable VSTHRD010
										ReloadWebView();
#pragma warning restore VSTHRD010
										break;
									}

									Send(value);
								}
							}
							catch (OperationCanceledException ex) {
								//no need to pass the error, this exception is expected
								Log.Verbose(ex.Message);
							}
							catch (Exception ex) {
								Log.Error(ex, ex.Message);
							}
						}
					}
					catch (Exception ex) {
						Log.Error(ex.Message);
					}
				}, processorToken, TaskCreationOptions.None, TaskScheduler.Default);
			}
			catch (Exception ex) {
				Log.Fatal(ex, nameof(DotNetBrowserService));
			}
		}

		public virtual void Initialize() {
			Log.Verbose($"{GetType()} {nameof(Initialize)} Browser...");
			OnInitialized();
			Log.Verbose($"{GetType()} {nameof(Initialize)} Browser");
		}

		protected void OnInitialized() {
			var switches = DotNetBrowserSwitches.Create(BrowserType);

			BrowserPreferences.SetChromiumSwitches(switches.ToArray());

			_path = GetOrCreateContextParamsPath();
			_browserContext = new BrowserContext(new BrowserContextParams(_path));

			var browser = BrowserFactory.Create(_browserContext, BrowserType);

			browser.Preferences.AllowDisplayingInsecureContent = false;
			browser.Preferences.AllowRunningInsecureContent = false;
			browser.Preferences.AllowScriptsToCloseWindows = false;
			browser.Preferences.ApplicationCacheEnabled = false;
			browser.Preferences.DatabasesEnabled = false;
			browser.Preferences.LocalStorageEnabled = false;
			browser.Preferences.PluginsEnabled = false;
			browser.Preferences.TransparentBackground = true;
			browser.Preferences.UnifiedTextcheckerEnabled = false;
			browser.Preferences.WebAudioEnabled = false;

			browser.DialogHandler = this;
			browser.LoadHandler = this;
			browser.Context.NetworkService.ResourceHandler = this;

			browser.RenderGoneEvent += Browser_RenderGoneEvent;
			browser.ScriptContextCreated += Browser_ScriptContextCreated;

			_browserView = new WPFBrowserView(browser);

			_browserView.InputBindings.Add(new InputBinding(new BookmarkShortcut1Command(), new KeyChordGesture(ModifierKeys.Shift | ModifierKeys.Control, Key.OemQuestion, Key.D1)));
			_browserView.InputBindings.Add(new InputBinding(new BookmarkShortcut2Command(), new KeyChordGesture(ModifierKeys.Shift | ModifierKeys.Control, Key.OemQuestion, Key.D2)));
			_browserView.InputBindings.Add(new InputBinding(new BookmarkShortcut3Command(), new KeyChordGesture(ModifierKeys.Shift | ModifierKeys.Control, Key.OemQuestion, Key.D3)));
			_browserView.InputBindings.Add(new InputBinding(new BookmarkShortcut4Command(), new KeyChordGesture(ModifierKeys.Shift | ModifierKeys.Control, Key.OemQuestion, Key.D4)));
			_browserView.InputBindings.Add(new InputBinding(new BookmarkShortcut5Command(), new KeyChordGesture(ModifierKeys.Shift | ModifierKeys.Control, Key.OemQuestion, Key.D5)));
			_browserView.InputBindings.Add(new InputBinding(new BookmarkShortcut6Command(), new KeyChordGesture(ModifierKeys.Shift | ModifierKeys.Control, Key.OemQuestion, Key.D6)));
			_browserView.InputBindings.Add(new InputBinding(new BookmarkShortcut7Command(), new KeyChordGesture(ModifierKeys.Shift | ModifierKeys.Control, Key.OemQuestion, Key.D7)));
			_browserView.InputBindings.Add(new InputBinding(new BookmarkShortcut8Command(), new KeyChordGesture(ModifierKeys.Shift | ModifierKeys.Control, Key.OemQuestion, Key.D8)));
			_browserView.InputBindings.Add(new InputBinding(new BookmarkShortcut9Command(), new KeyChordGesture(ModifierKeys.Shift | ModifierKeys.Control, Key.OemQuestion, Key.D9)));

#if DEBUG
			Log.Debug(GetDevToolsUrl());
#endif

		}

		private void Browser_RenderGoneEvent(object sender, RenderEventArgs e) {
			Log.Verbose(nameof(Browser_RenderGoneEvent));
#pragma warning disable VSTHRD010
			ReloadWebView();
#pragma warning restore VSTHRD010
		}

		private void Browser_ScriptContextCreated(object sender, DotNetBrowser.Events.ScriptContextEventArgs e) {
			var jsValue = _browserView.Browser.ExecuteJavaScriptAndReturnValue("window");
			jsValue.AsObject().SetProperty("PostMessageInterop", new PostMessageInterop());

			Log.Verbose($"{nameof(Browser_ScriptContextCreated)} set window object");

			_browserView.Browser.ExecuteJavaScript(@"
				  window.acquireHostApi = function() {
					  return {
						  postMessage: function(message) {
							window.PostMessageInterop.Handle(JSON.stringify(message));
						 }
					 }
				  }
			   ");

			Log.Verbose($"{nameof(Browser_ScriptContextCreated)} ExecuteJavaScript");
		}

		public void AddWindowMessageEvent(WindowMessageHandler messageHandler) {
			PostMessageInterop.MessageHandler = messageHandler;
			Log.Verbose($"{nameof(AddWindowMessageEvent)}");
		}

		/// <summary>
		/// Sends message to the browser, also contains logic for queuing messages
		/// before the agent is ready
		/// </summary>
		/// <param name="message"></param>
		/// <param name="canEnqueue"></param>
		public void PostMessage(string message, bool canEnqueue = false) {
			if (canEnqueue) {
				if (!_messageQueue.TryAdd(message)) {
					Log.Verbose($"failed to add: {message}");
				}
			}
			else {
				//not a deferred and not triggered -- work as normal
				Send(message);
			}
		}

		protected virtual void Send(string message) {
			if (_browserView == null || _browserView.Browser == null) {
				Log.Warning("Browser is null");
				return;
			}

			_browserView.Browser.ExecuteJavaScript(@"window.postMessage(" + message + @",""*"");");
		}

		public void LoadHtml(string html) {
			using (Log.CriticalOperation($"{nameof(LoadHtml)}")) {
				_browserView.Browser.LoadHTML(html);
			}
		}

		public void AttachControl(FrameworkElement frameworkElement) {
			var grid = frameworkElement as Grid;
			if (grid == null)
				throw new InvalidOperationException("Grid");

			Grid.SetColumn(grid, 0);
			grid.Children.Add(_browserView);
		}

		public string GetDevToolsUrl() {
			var url = _browserView.Browser.GetRemoteDebuggingURL();
			Log.Verbose($"DevTools Url={url}");
			return url;
		}

		/// <summary>
		/// Checks known files to see if DotNetBrowser is active. First a .lock file (randomly named), then a file known to exist in the directory (History)
		/// </summary>
		/// <param name="directoryPath"></param>
		/// <param name="lockInfo"></param>
		/// <param name="fileKnownToBeLocked">this is a known file name that lives in the DotNetBrowserDir that is known to hold a file lock</param>
		/// <returns></returns>
		private bool TryCheckUsage(string directoryPath, out DirectoryLockInfo lockInfo, string fileKnownToBeLocked = "History") {
			lockInfo = new DirectoryLockInfo(directoryPath);

			try {
				// this dir, doesn't exist... good to go!
				if (!Directory.Exists(directoryPath)) return false;

				var di = new DirectoryInfo(directoryPath);
				foreach (var file in di.GetFiles()) {
					if (file.Extension.EqualsIgnoreCase(".lock")) {
						lockInfo.LockFile = file.FullName;
						return true;
					}
					if (file.Name.EqualsIgnoreCase(fileKnownToBeLocked)) {
						if (IsFileLocked(file.FullName)) {
							lockInfo.LockFile = file.FullName;
							return true;
						}
					}
				}
			}
			catch (Exception ex) {
				Log.Warning(ex, "IsInUse?");
				return true;
			}

			return false;
		}

		private string GetOrCreateContextParamsPath() {
			// the default directory from DotNetBrowser looks something like this:
			// C:\Users\<UserName>\AppData\Local\Temp\dotnetbrowser-chromium\64.0.3282.24.1.19.0.0.642\32bit\data
			// get it with BrowserPreferences.GetDefaultDataDir();

			var defaultPath = Application.TempDataPath + "Browser-0";
			Log.Verbose($"DefaultPath={defaultPath}");

			if (!TryCheckUsage(defaultPath, out DirectoryLockInfo info)) {
				if (!info.HasLocked) {
					Log.Debug($"Reusing {defaultPath} (not locked)");
					return defaultPath;
				}

				Log.Debug($"Could not reuse ${defaultPath} - ${info.LockFile}");
			}

			string path = null;

			// this is mainly for dev / DEBUG -- users should never get this high
			for (var i = 1; i < 2000; i++) {
				path = Path.Combine(Application.TempDataPath, $"Browser-{i}");
				if (Directory.Exists(path)) {
					var isLocked = TryCheckUsage(path, out DirectoryLockInfo lockInfo);
					if (lockInfo.HasLocked) {
						// this path/file exists, but it is locked, try another
						Log.Verbose($"{path}|{lockInfo.LockFile} IsLocked={isLocked}");
						continue;
					}

					Log.Debug($"Using {path} -- (Not locked, use this)");
					// not locked... use it!
					break;
				}
				else {
					Log.Debug($"Using {path} -- (Doesn't exist)");
					// doesn't exist -- use it!
					break;
				}
			}

			return path;
		}

		public virtual void PostMessage(IAbstractMessageType message, bool canEnqueue = false) {
			PostMessage(message.AsJson(), canEnqueue);
		}

		/// <summary>
		/// Reloads the Webview. Requires the UI thread
		/// </summary>
		public virtual void ReloadWebView() {
			ThreadHelper.JoinableTaskFactory.Run(async delegate {
				await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
				LoadWebView();
				Log.Debug($"{nameof(ReloadWebView)}");
			});
		}


		/// <summary>
		/// Loads the Webview. Requires the UI thread
		/// </summary>
		public void LoadWebView() {
			ThreadHelper.JoinableTaskFactory.Run(async delegate {
				await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
				LoadHtml(CreateWebViewHarness(Assembly.GetAssembly(typeof(IBrowserService)), "webview"));
			});
		}

		/// <summary>
		/// Loads the Splash view. Requires the UI thread
		/// </summary>
		public void LoadSplashView() {
			ThreadHelper.JoinableTaskFactory.Run(async delegate {
				await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
				LoadHtml(CreateWebViewHarness(Assembly.GetAssembly(typeof(IBrowserService)), "waiting"));
			});
		}

		private bool _isDisposed;

		public void Dispose() {
			if (!_isDisposed) {
				Log.Verbose("Browser Dispose...");

				Dispose(true);
				_isDisposed = true;
			}
		}

		protected void Dispose(bool disposing) {
			if (_isDisposed) return;

			var success = true;
			if (disposing) {
				try {
					try {
						_queueTokenSource?.Cancel();
						_processorTokenSource?.Cancel();
						_manualResetEvent.Set();
					}
					catch (Exception ex) {
						Log.Warning(ex, "aux component failed to dispose");
					}

					if (_browserView == null) {
						Log.Verbose("DotNetBrowser is null");
						return;
					}

					if (_browserView?.IsDisposed == true) {
						Log.Verbose("DotNetBrowser already disposed");
						return;
					}
					try {
						_browserView.InputBindings.Clear();
						_sessionReadyEvent?.Dispose();
						_sessionLogoutEvent?.Dispose();

						_browserView.Browser.RenderGoneEvent -= Browser_RenderGoneEvent;
						_browserView.Browser.ScriptContextCreated -= Browser_ScriptContextCreated;
					}
					catch (Exception ex) {
						Log.Warning(ex, "aux component failed to dispose");
					}

					_browserView.Dispose();
					_browserView.Browser.Dispose();
					_browserView.Browser.Context.Dispose();
					_browserView = null;

					var deleted = false;
					for (var i = 0; i < 5; i++) {
						if (deleted) break;

						try {
							Directory.Delete(_path, true);
							deleted = true;
							Log.Verbose($"Cleaned up {_path} on {i + 1} attempt");
						}
						catch (Exception ex) {
							Log.Warning(ex, $"Could not delete attempt ({i + 1}) {_path}");
						}
					}
				}
				catch (Exception ex) {
					Log.Warning(ex, "DotNetBrowser dispose failure");
					success = false;
				}

				if (success) {
					Log.Verbose("DotNetBrowser Disposed");
				}

				_isDisposed = true;
			}
		}

		private void SendInternal(IAbstractMessageType message, bool canEnqueue = false) {
			using (IpcLogger.CriticalOperation(Log, "RES", message, canEnqueue)) {
				PostMessage(message, canEnqueue);
			}
		}

		public void Send(IAbstractMessageType message) => SendInternal(message);
		public void Send(IRequestType message) => SendInternal(message);
		public void Notify(INotificationType message) => SendInternal(message);
		public void EnqueueNotification(INotificationType message) => SendInternal(message, true);

		/// <summary>
		/// Sends the notification on a background thread
		/// </summary>
		/// <param name="message"></param>
		/// <returns></returns>
		public System.Threading.Tasks.Task NotifyAsync(INotificationType message) {
			return System.Threading.Tasks.Task.Factory.StartNew(() => {
				SendInternal(message);
			}, CancellationToken.None, TaskCreationOptions.None, TaskScheduler.Current);
		}

		/// <summary>
		/// Creates the harness string. Requires the UI thread.
		/// </summary>
		/// <param name="assembly"></param>
		/// <param name="resourceName"></param>
		/// <returns></returns>
		private string CreateWebViewHarness(Assembly assembly, string resourceName) {
			string harness = null;
			try {
				ThreadHelper.ThrowIfNotOnUIThread();

				var resourceManager = new ResourceManager("VSPackage", Assembly.GetExecutingAssembly());
				var dir = Path.GetDirectoryName(assembly.Location);
				Debug.Assert(dir != null, nameof(dir) + " != null");

				// ReSharper disable once ResourceItemNotResolved
				harness = resourceManager.GetString(resourceName);
				Debug.Assert(harness != null, nameof(harness) + " != null");

				harness = harness.Replace("{root}", dir.Replace(@"\", "/"));
				// ReSharper disable once ResourceItemNotResolved
				var styleSheet = resourceManager.GetString("theme");

				var theme = ThemeManager.Generate();
				var isDebuggingEnabled = Log.IsDebugEnabled();

				var outputDebug = new Dictionary<string, Tuple<string, string>>();
				harness = harness.Replace("{bodyClass}", theme.IsDark ? "vscode-dark" : "vscode-light");

				if (styleSheet != null) {
					foreach (var item in theme.ThemeResources) {
						styleSheet = styleSheet.Replace($"--cs--{item.Key}--", item.Value);

						if (isDebuggingEnabled) {
							outputDebug[item.Key] = Tuple.Create(item.Key, item.Value);
						}
					}

					foreach (var item in theme.ThemeColors) {
						var color = theme.IsDark
							? item.DarkModifier == null ? item.Color : item.DarkModifier(item.Color)
							: item.LightModifier == null ? item.Color : item.LightModifier(item.Color);

						styleSheet = styleSheet.Replace($"--cs--{item.Key}--", color.ToRgba());

						if (isDebuggingEnabled) {
							outputDebug[item.Key] = Tuple.Create(item.Key, color.ToRgba());
						}
					}
				}

				harness = harness.Replace(@"<style id=""theme""></style>", $@"<style id=""theme"">{styleSheet}</style>");

#if !DEBUG
			if (isDebuggingEnabled)
			{
				Log.Debug(outputDebug.ToJson(format: true));
				Log.Debug(styleSheet);
			}
			Log.Verbose(harness);
#endif
			}
			catch (Exception ex) {
				Log.Error(ex, nameof(CreateWebViewHarness));
			}
			return harness;
		}


		#region DialogHandlers

		bool LoadHandler.OnLoad(LoadParams loadParams) {
			return false;
		}

		bool LoadHandler.CanNavigateOnBackspace() {
			return false;
		}

		bool LoadHandler.OnCertificateError(CertificateErrorParams errorParams) {
			return false;
		}

		bool ResourceHandler.CanLoadResource(ResourceParams parameters) {
			if (parameters.ResourceType == ResourceType.IMAGE || parameters.URL.StartsWith("file://")) {
				return true;
			}

			if (parameters.ResourceType == ResourceType.MAIN_FRAME) {
				try {
					_ = _codeStreamAgentServiceFactory.Create().SendAsync<JToken>("codestream/url/open", new { url = parameters.URL });
				}
				catch (Exception ex) {
					Log.Error(ex, "CanLoadResource");
				}
			}

			return false;
		}

		CloseStatus DialogHandler.OnBeforeUnload(UnloadDialogParams parameters) {
			return CloseStatus.CANCEL;
		}

		void DialogHandler.OnAlert(DialogParams parameters) {
		}

		CloseStatus DialogHandler.OnConfirmation(DialogParams parameters) {
			return CloseStatus.CANCEL;
		}

		CloseStatus DialogHandler.OnFileChooser(FileChooserParams parameters) {
			return CloseStatus.CANCEL;
		}

		CloseStatus DialogHandler.OnPrompt(PromptDialogParams parameters) {
			return CloseStatus.CANCEL;
		}

		CloseStatus DialogHandler.OnReloadPostData(ReloadPostDataParams parameters) {
			return CloseStatus.CANCEL;
		}

		CloseStatus DialogHandler.OnColorChooser(ColorChooserParams parameters) {
			return CloseStatus.CANCEL;
		}

		CloseStatus DialogHandler.OnSelectCertificate(CertificatesDialogParams parameters) {
			return CloseStatus.CANCEL;
		}

		#endregion

		private class DotNetBrowserSwitches {
			/// <summary>
			/// These switches must be used in either rendering
			/// </summary>
			private static readonly List<string> DefaultSwitches = new List<string>
			{
#if DEBUG
				"--remote-debugging-port=9224",
#else
				"--remote-debugging-port=9223",
#endif
				"--disable-web-security",
				"--allow-file-access-from-files"
			};

			/// <summary>
			/// For improved LIGHTWEIGHT rendering
			/// </summary>
			/// <remarks>see https://dotnetbrowser.support.teamdev.com/support/solutions/articles/9000124916-accelerated-lightweight-rendering</remarks>
			private static readonly List<string> LightweightSwitches = new List<string>
			{
				"--disable-gpu",
				"--disable-gpu-compositing",
				"--enable-begin-frame-scheduling",
				"--software-rendering-fps=60"
			};

			public static List<string> Create(BrowserType browserType) {
				var switches = new List<string>(DefaultSwitches);
				if (browserType == BrowserType.LIGHTWEIGHT) {
					switches = switches.Combine(LightweightSwitches);
				}
				return switches;
			}
		}
	}
}
