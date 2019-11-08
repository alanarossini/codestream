"use strict";
import {
	Block,
	KnownBlock,
	LogLevel,
	WebAPICallOptions,
	WebAPICallResult,
	WebClient,
	WebClientEvent
} from "@slack/web-api";
import HttpsProxyAgent from "https-proxy-agent";
import { Container, SessionContainer } from "../../container";
import { Logger, TraceLevel } from "../../logger";
import {
	Capabilities,
	CreatePostResponse,
	CreateSharedExternalPostRequest,
	FetchStreamsRequest,
	FetchStreamsResponse,
	FetchUsersResponse,
	GetStreamRequest
} from "../../protocol/agent.protocol";
import {
	CSChannelStream,
	CSDirectStream,
	CSGetMeResponse,
	CSMe,
	CSSlackProviderInfo,
	CSTeam,
	CSUser,
	ProviderType,
	StreamType
} from "../../protocol/api.protocol";
import { debug, Functions, log, Strings } from "../../system";
import { MessageType, StreamsRTMessage } from "../apiProvider";

import { CodeStreamApiProvider } from "api/codestream/codestreamApi";
import {
	fromSlackChannel,
	fromSlackChannelIdToType,
	fromSlackChannelOrDirect,
	fromSlackDirect,
	fromSlackPost,
	fromSlackPostId,
	fromSlackUser,
	toSlackPostBlocks,
	toSlackPostText
} from "./slackSharingApi.adapters";

interface DeferredStreamRequest<TResult> {
	action(): Promise<TResult>;
	grouping: number;
	order: number;
	stream: {
		id: string;
		priority?: number;
	};
}

const meMessageRegex = /^\/me /;

export class SlackSharingApiProvider {
	providerType = ProviderType.Slack;
	private _slack: WebClient;
	private readonly _slackToken: string;
	private readonly _slackUserId: string;

	// TODO: Convert to index on UserManager?
	private _usernamesById: Map<string, string> | undefined;
	// TODO: Convert to index on UserManager?
	private _userIdsByName: Map<string, string> | undefined;

	readonly capabilities: Capabilities = {
		channelMute: false,
		postDelete: true,
		postEdit: true,
		// webview uses this to see if the provider can upgrade to realtime.
		// to hide the channels tab -- make this false
		providerCanSupportRealtimeChat: false,
		providerSupportsRealtimeChat: false,
		// agent uses this
		providerSupportsRealtimeEvents: false
	};

	constructor(
		private _codestream: CodeStreamApiProvider,
		private _codestreamTeam: CSTeam | undefined,
		providerInfo: CSSlackProviderInfo,

		private readonly _codestreamTeamId: string,
		private readonly _proxyAgent: HttpsProxyAgent | undefined
	) {
		this._slackToken = providerInfo.accessToken;
		this._slack = this.newWebClient();
		this._slack.on(WebClientEvent.RATE_LIMITED, retryAfter => {
			Logger.log(
				`SlackSharingApiProvider request was rate limited and future requests will be paused for ${retryAfter} seconds`
			);
		});
		this._slackUserId = providerInfo.userId;
	}

	protected newWebClient() {
		return new WebClient(this._slackToken, {
			agent: this._proxyAgent,
			logLevel: Logger.level === TraceLevel.Debug ? LogLevel.DEBUG : LogLevel.INFO,
			logger: {
				setLevel() {},
				setName() {},
				debug(...msgs) {
					Logger.debug("SLACK", ...msgs);
				},
				info(...msgs) {
					Logger.log("SLACK", ...msgs);
				},
				warn(...msgs) {
					SlackSharingApiProvider.tryTrackConnectivityIssues(msgs);
					Logger.warn("SLACK", ...msgs);
				},
				error(...msgs) {
					SlackSharingApiProvider.tryTrackConnectivityIssues(msgs);
					Logger.warn("SLACK [ERROR]", ...msgs);
				}
			}
		});
	}

	private static tryTrackConnectivityIssues(msgs: string[]) {
		try {
			if (!msgs || !msgs.length) return;

			const msg = msgs[0];
			if (
				!msg ||
				typeof msg !== "string" ||
				msg.indexOf("self signed certificate in certificate chain") === -1
			) {
				return;
			}

			const telemetry = Container.instance().telemetry;
			if (!telemetry) return;

			telemetry.track({
				eventName: "Connect Error",
				properties: {
					Error: msg,
					Provider: "Slack"
				}
			});
		} catch (error) {
			Logger.error(error);
		}
	}

	// private async getSlackPreferences() {
	// 	// Use real-time events as a proxy for limited-slack mode (which can't use undocumented apis)
	// 	if (!this.capabilities.providerSupportsRealtimeEvents) {
	// 		return { muted_channels: "" };
	// 	}

	// 	try {
	// 		// Undocumented API: https://github.com/ErikKalkoken/slackApiDoc/blob/master/users.prefs.get.md
	// 		const response = await this.slackApiCall("users.prefs.get", undefined);

	// 		const { ok, error, prefs } = response as WebAPICallResult & { prefs: any };
	// 		if (!ok) {
	// 			Logger.error(new Error(error));
	// 			return { muted_channels: "" };
	// 		}

	// 		return prefs as { [key: string]: any };
	// 	} catch (ex) {
	// 		Logger.error(ex);
	// 		return { muted_channels: "" };
	// 	}
	// }

	// get unreads(): SlackUnreads {
	// 	return undefined;
	// }

	get userId(): string {
		return this._slackUserId;
	}

	// protected newSlackEvents() {
	// 	return new SlackEvents(this._slackToken, this, this._proxyAgent);
	// }

	async ensureUsernamesById(): Promise<Map<string, string>> {
		if (this._usernamesById === undefined) {
			void (await this.ensureUserMaps());
		}
		return this._usernamesById!;
	}

	private async ensureUserIdsByName(): Promise<Map<string, string>> {
		if (this._userIdsByName === undefined) {
			void (await this.ensureUserMaps());
		}

		return this._userIdsByName!;
	}

	private async ensureUserMaps(): Promise<void> {
		if (this._usernamesById === undefined || this._userIdsByName === undefined) {
			const users = (await this.fetchUsers()).users;

			this._usernamesById = new Map();
			this._userIdsByName = new Map();

			for (const user of users) {
				this._usernamesById.set(user.id, user.username);
				this._userIdsByName.set(user.username, user.id);
			}
		}
	}

	@log()
	async createExternalPost(request: CreateSharedExternalPostRequest): Promise<CreatePostResponse> {
		let createdPostId;
		try {
			const usernamesById = await this.ensureUsernamesById();
			const userIdsByName = await this.ensureUserIdsByName();

			let text = request.text;
			let meMessage = meMessageRegex.test(text);
			// If we are trying post a me message as a reply, send it as a normal reply with /me replaced with the username
			if (meMessage && request.parentPostId != null) {
				text = text.replace(meMessageRegex, `${usernamesById.get(this._slackUserId)} `);
				meMessage = false;
			}

			if (text) {
				text = toSlackPostText(text, userIdsByName, request.mentionedUserIds);
			}

			const { streamId, postId: parentPostId } = fromSlackPostId(
				request.parentPostId,
				request.channelId!
			);

			// if (meMessage) {
			// 	const response = await this.slackApiCall("chat.meMessage", {
			// 		channel: streamId,
			// 		text: text
			// 	});

			// 	const { ok, error, ts: postId } = response as WebAPICallResult & { ts?: any };
			// 	if (!ok) throw new Error(error);

			// 	const postResponse = await this.getPost({ streamId: streamId, postId: postId });
			// 	return postResponse;
			// }

			let blocks: (KnownBlock | Block)[] | undefined;
			// let codemark: CSCodemark | undefined;
			// let markers: CSMarker[] | undefined;
			// let markerLocations: CSMarkerLocations[] | undefined;
			// let streams: CSStream[] | undefined;
			// let repos: CSRepository[] | undefined;

			if (request.codemark != null) {
				const codemark = request.codemark;
				blocks = toSlackPostBlocks(codemark, request.remotes, usernamesById, userIdsByName);

				// Set the fallback (notification) content for the message
				text = `${codemark.title || ""}${
					codemark.title && codemark.text ? `\n\n` : ""
				}${codemark.text || ""}`;
			}

			const response = await this.slackApiCall("chat.postMessage", {
				channel: streamId,
				text: text,
				as_user: true,
				thread_ts: parentPostId,
				unfurl_links: true,
				reply_broadcast: false, // parentPostId ? true : undefined --- because of slack bug (https://trello.com/c/Y48QI6Z9/919)
				blocks: blocks !== undefined ? blocks : undefined
			});

			const { ok, error, message } = response as WebAPICallResult & { message?: any; ts?: any };
			if (!ok) throw new Error(error);

			// todo fix me cheese
			const post = await fromSlackPost(message, streamId, usernamesById, this._codestreamTeamId);
			const { postId } = fromSlackPostId(post.id, post.streamId);
			createdPostId = postId;

			return {
				post: post
				// codemark,
				// markers,
				// markerLocations,
				// streams,
				// repos
			};
		} finally {
			if (createdPostId) {
				// this._codestream.trackProviderPost({
				// 	provider: "slack",
				// 	teamId: this.teamId,
				// 	streamId: request.streamId,
				// 	postId: createdPostId,
				// 	parentPostId: request.parentPostId
				// });
			}
		}
	}

	@log()
	async fetchCounts(): Promise<
		| {
				channels: { [id: string]: any };
				groups: { [id: string]: any };
				ims: { [id: string]: any };
		  }
		| undefined
	> {
		// Use real-time events as a proxy for limited-slack mode (which can't use undocumented apis)
		if (!this.capabilities.providerSupportsRealtimeEvents) {
			return undefined;
		}

		const cc = Logger.getCorrelationContext();

		try {
			// Undocumented API
			const response = await this.slackApiCall("users.counts", {
				include_threads: true,
				// mpim_aware: true,
				only_relevant_ims: true,
				simple_unreads: true
			});

			const { ok, error, channels, groups, ims } = response as WebAPICallResult & {
				channels: any[];
				groups: any[];
				ims: any[];
			};
			if (!ok) throw new Error(error);

			return {
				channels: (channels == null ? [] : channels).reduce((map, c) => {
					if (!c.is_archived) {
						map[c.id] = c;
					}
					return map;
				}, Object.create(null)),
				groups: (groups == null ? [] : groups).reduce((map, g) => {
					if (!g.is_archived) {
						map[g.id] = g;
					}
					return map;
				}, Object.create(null)),
				ims: (ims == null ? [] : ims).reduce((map, im) => {
					map[im.id] = im;
					return map;
				}, Object.create(null))
			};
		} catch (ex) {
			Logger.error(ex, cc);
			return undefined;
		}
	}

	@log({
		exit: (r: FetchStreamsResponse) =>
			`\n${r.streams
				.map(
					s =>
						`\t${s.id} = ${s.name}${s.priority == null ? "" : `, p=${s.priority}`}${
							s.type === StreamType.Direct ? `, closed=${s.isClosed}` : ""
						}`
				)
				.join("\n")}\ncompleted`
	})
	async fetchStreams(request: FetchStreamsRequest) {
		const cc = Logger.getCorrelationContext();

		try {
			const responses = await this.slackApiCallPaginated("users.conversations", {
				exclude_archived: true,
				types: "public_channel,private_channel,mpim,im",
				limit: 1000
			});

			const start = process.hrtime();
			Logger.log(cc, "Fetching pages...");

			const conversations = [];
			for await (const response of responses) {
				const { ok, error, channels: data } = response as WebAPICallResult & {
					channels: any[];
				};
				if (!ok) throw new Error(error);

				Logger.log(
					cc,
					`Fetched page; cursor=${response.response_metadata &&
						response.response_metadata.next_cursor}`
				);

				conversations.push(...data);
			}

			Logger.log(cc, `Fetched pages \u2022 ${Strings.getDurationMilliseconds(start)} ms`);

			const usernamesById = await this.ensureUsernamesById();
			const counts = await this.fetchCounts();

			const pendingRequestsQueue: DeferredStreamRequest<CSChannelStream | CSDirectStream>[] = [];

			const [channels, groups, ims] = await Promise.all([
				this.fetchChannels(
					// Filter out shared channels for now, until we can convert to the conversation apis
					conversations.filter(c => c.is_channel && !c.is_shared),
					counts && counts.channels,
					pendingRequestsQueue
				),
				this.fetchGroups(
					// Filter out shared channels for now, until we can convert to the conversation apis
					conversations.filter(c => c.is_group && !c.is_shared),
					usernamesById,
					counts && counts.groups,
					pendingRequestsQueue
				),
				this.fetchIMs(
					conversations.filter(c => c.is_im),
					usernamesById,
					counts && counts.ims,
					pendingRequestsQueue
				)
			]);

			const streams = channels.concat(...groups, ...ims);
			// if (counts !== undefined) {
			// 	this._unreads.updateFromCounts(counts);
			// }
			if (this.capabilities.providerSupportsRealtimeEvents && pendingRequestsQueue.length !== 0) {
				this.processPendingStreamsQueue(pendingRequestsQueue);
			}

			if (
				request.types != null &&
				request.types.length !== 0 &&
				(!request.types.includes(StreamType.Channel) || !request.types.includes(StreamType.Direct))
			) {
				return { streams: streams.filter(s => request.types!.includes(s.type)) };
			}

			return { streams: streams };
		} catch (ex) {
			Logger.error(ex, cc);
			throw ex;
		}
	}

	@log({
		args: false,
		correlate: true,
		enter: q => `fetching ${q.length} stream(s) in the background...`
	})
	protected async processPendingStreamsQueue(
		queue: DeferredStreamRequest<CSChannelStream | CSDirectStream>[]
	) {
		const cc = Logger.getCorrelationContext();

		queue.sort((a, b) => b.grouping - a.grouping || a.order - b.order);

		const { streams } = SessionContainer.instance();

		const notifyThrottle = 4000;
		let timeSinceLastNotification = new Date().getTime();
		const completed: (CSChannelStream | CSDirectStream)[] = [];

		let failed = 0;
		while (queue.length) {
			const deferred = queue.shift();
			if (deferred === undefined) continue;

			try {
				const timeoutMs = 30000;
				const timer = setTimeout(async () => {
					Logger.warn(
						cc,
						`TIMEOUT ${timeoutMs / 1000}s exceeded while fetching stream '${
							deferred.stream.id
						}' in the background`
					);

					if (completed.length !== 0) {
						const message: StreamsRTMessage = { type: MessageType.Streams, data: completed };
						message.data = await streams.resolve(message);
						// this._onDidReceiveMessage.fire(message);

						completed.length = 0;
						timeSinceLastNotification = new Date().getTime();
					}
				}, timeoutMs);

				const stream = await deferred.action();
				// Since the info calls may not return the priority, preserve the existing state
				if (stream.type === StreamType.Direct && stream.priority == null) {
					stream.priority = deferred.stream.priority;
				}

				clearTimeout(timer);
				completed.push(stream);
			} catch {
				failed++;
			}

			if (
				queue.length === 0 ||
				(completed.length !== 0 &&
					new Date().getTime() - timeSinceLastNotification > notifyThrottle)
			) {
				const message: StreamsRTMessage = { type: MessageType.Streams, data: completed };
				message.data = await streams.resolve(message);
				// 	this._onDidReceiveMessage.fire(message);

				completed.length = 0;
				timeSinceLastNotification = new Date().getTime();
			}
		}

		if (failed > 0) {
			Logger.debug(cc, `Failed fetching ${failed} stream(s) in the background`);
		}
	}

	@debug({ args: false })
	private async fetchChannels(
		channels: any | undefined,
		countsByChannel: { [id: string]: any } | undefined,
		pendingQueue: DeferredStreamRequest<CSChannelStream | CSDirectStream>[]
	): Promise<(CSChannelStream | CSDirectStream)[]> {
		const cc = Logger.getCorrelationContext();

		if (channels === undefined) {
			const responses = await this.slackApiCallPaginated("channels.list", {
				exclude_archived: true,
				exclude_members: false,
				limit: 1000
			});

			const start = process.hrtime();
			Logger.log(cc, "Fetching pages...");

			channels = [];
			for await (const response of responses) {
				const { ok, error, channels: data } = response as WebAPICallResult & {
					channels: any[];
				};
				if (!ok) throw new Error(error);

				Logger.log(
					cc,
					`Fetched page; cursor=${response.response_metadata &&
						response.response_metadata.next_cursor}`
				);

				channels.push(...data);
			}

			Logger.log(cc, `Fetched pages \u2022 ${Strings.getDurationMilliseconds(start)} ms`);
		}

		const streams = [];
		let pending:
			| {
					action(): Promise<CSChannelStream>;
					id: string;
					name: string;
			  }[]
			| undefined;

		let counts;
		let s;
		for (const c of channels) {
			if (c.is_archived) continue;

			if (countsByChannel != null) {
				counts = countsByChannel[c.id];
				if (counts !== undefined) {
					if (counts.latest != null) {
						c.latest = { ts: counts.latest };
					}
				}
			}

			s = fromSlackChannel(c, this._slackUserId, this._codestreamTeamId);
			streams.push(s);

			if (countsByChannel !== undefined && counts === undefined) continue;

			// if (c.is_member) {
			if (pending === undefined) {
				pending = [];
			}

			pending.push({
				action: () => this.fetchChannel(c.id),
				id: c.id,
				name: c.name as string
			});
			// }
		}

		if (pending !== undefined) {
			pending.sort((a, b) => a.name.localeCompare(b.name));

			const index = 0;
			for (const p of pending) {
				pendingQueue.push({ action: p.action, grouping: 10, order: index, stream: { id: p.id } });
			}
		}

		return streams;
	}

	@log({
		args: false,
		prefix: (context, id) => `${context.prefix}(${id})`
	})
	private async fetchChannel(id: string) {
		const cc = Logger.getCorrelationContext();

		try {
			const response = await this.slackApiCall("channels.info", {
				channel: id
			});

			const { ok, error, channel } = response as WebAPICallResult & { channel: any };
			if (!ok) throw new Error(error);

			// this._unreads.update(channel.id, channel.last_read, 0, channel.unread_count_display || 0);

			return fromSlackChannel(channel, this._slackUserId, this._codestreamTeamId);
		} catch (ex) {
			Logger.error(ex, cc);
			throw ex;
		}
	}

	@debug({ args: false })
	private async fetchGroups(
		groups: any | undefined,
		usernamesById: Map<string, string>,
		countsByGroup: { [id: string]: any } | undefined,
		pendingQueue: DeferredStreamRequest<CSChannelStream | CSDirectStream>[]
	): Promise<(CSChannelStream | CSDirectStream)[]> {
		const cc = Logger.getCorrelationContext();

		if (groups === undefined) {
			const responses = await this.slackApiCallPaginated("groups.list", {
				exclude_archived: true,
				exclude_members: false,
				limit: 1000
			});

			const start = process.hrtime();
			Logger.log(cc, "Fetching pages...");

			groups = [];
			for await (const response of responses) {
				const { ok, error, groups: data } = response as WebAPICallResult & {
					groups: any[];
				};
				if (!ok) throw new Error(error);

				Logger.log(
					cc,
					`Fetched page; cursor=${response.response_metadata &&
						response.response_metadata.next_cursor}`
				);

				groups.push(...data);
			}

			Logger.log(cc, `Fetched pages \u2022 ${Strings.getDurationMilliseconds(start)} ms`);
		}
		const streams = [];
		let pending:
			| {
					action(): Promise<CSChannelStream | CSDirectStream>;
					grouping: number;
					id: string;
					priority: number;
			  }[]
			| undefined;
		let counts;
		let s;
		for (const g of groups) {
			if (g.is_archived) continue;

			if (countsByGroup != null) {
				counts = countsByGroup[g.id];
				if (counts !== undefined) {
					g.is_open = counts.is_open;
					if (counts.latest != null) {
						g.latest = { ts: counts.latest };
					}
				} else {
					g.is_open = false;
				}
			}

			s = fromSlackChannelOrDirect(g, usernamesById, this._slackUserId, this._codestreamTeamId);
			if (s !== undefined) {
				streams.push(s);
			}

			if (countsByGroup !== undefined && counts === undefined) continue;

			if (g.is_open !== false) {
				if (pending === undefined) {
					pending = [];
				}

				pending.push({
					action: () => this.fetchGroup(g.id, usernamesById),
					grouping: g.is_mpim ? 1 : 5,
					id: g.id,
					priority: (g.priority || 0) as number
				});
			}
		}

		if (pending !== undefined) {
			pending.sort((a, b) => b.priority - a.priority);

			const index = 0;
			for (const p of pending) {
				pendingQueue.push({
					action: p.action,
					grouping: p.grouping,
					order: index,
					stream: { id: p.id, priority: p.priority }
				});
			}
		}

		return streams;
	}

	@log({
		args: false,
		prefix: (context, id) => `${context.prefix}(${id})`
	})
	private async fetchGroup(id: any, usernamesById: Map<string, string>) {
		const cc = Logger.getCorrelationContext();

		try {
			const response = await this.slackApiCall("groups.info", {
				channel: id
			});

			const { ok, error, group } = response as WebAPICallResult & { group: any };
			if (!ok) throw new Error(error);

			// this._unreads.update(
			// 	group.id,
			// 	group.last_read,
			// 	group.is_mpim ? group.unread_count_display || 0 : 0,
			// 	group.unread_count_display || 0
			// );

			return fromSlackChannelOrDirect(
				group,
				usernamesById,
				this._slackUserId,
				this._codestreamTeamId
			)!;
		} catch (ex) {
			Logger.error(ex, cc);
			throw ex;
		}
	}

	@debug({ args: false })
	private async fetchIMs(
		ims: any | undefined,
		usernamesById: Map<string, string>,
		countsByIM: { [id: string]: any } | undefined,
		pendingQueue: DeferredStreamRequest<CSChannelStream | CSDirectStream>[]
	): Promise<(CSChannelStream | CSDirectStream)[]> {
		const cc = Logger.getCorrelationContext();

		if (ims === undefined) {
			const responses = await this.slackApiCallPaginated("im.list", {
				limit: 1000
			});

			const start = process.hrtime();
			Logger.log(cc, "Fetching pages...");

			ims = [];
			for await (const response of responses) {
				const { ok, error, ims: data } = response as WebAPICallResult & {
					ims: any[];
				};
				if (!ok) throw new Error(error);

				Logger.log(
					cc,
					`Fetched page; cursor=${response.response_metadata &&
						response.response_metadata.next_cursor}`
				);

				ims.push(...data);
			}

			Logger.log(cc, `Fetched pages \u2022 ${Strings.getDurationMilliseconds(start)} ms`);
		}

		const streams = [];
		let pending:
			| {
					action(): Promise<CSDirectStream>;
					id: string;
					priority: number;
			  }[]
			| undefined;
		let counts;
		let s;
		for (const im of ims) {
			if (im.is_user_deleted) continue;

			if (countsByIM != null) {
				counts = countsByIM[im.id];
				if (counts !== undefined) {
					im.is_open = counts.is_open;
					if (counts.latest != null) {
						im.latest = { ts: counts.latest };
					}
				} else {
					im.is_open = false;
				}
			}

			s = fromSlackDirect(im, usernamesById, this._slackUserId, this._codestreamTeamId);
			streams.push(s);

			if (countsByIM !== undefined && counts === undefined) continue;

			if (s.isClosed !== false) {
				if (pending === undefined) {
					pending = [];
				}

				pending.push({
					action: () => this.fetchIM(im.id, usernamesById),
					id: im.id,
					priority: (im.priority || 0) as number
				});
			}
		}

		if (pending !== undefined) {
			pending.sort((a, b) => b.priority - a.priority);

			const index = 0;
			for (const p of pending) {
				pendingQueue.push({
					action: p.action,
					grouping: 0,
					order: index,
					stream: { id: p.id, priority: p.priority }
				});
			}
		}

		return streams;
	}

	@log({
		args: false,
		prefix: (context, id) => `${context.prefix}(${id})`
	})
	private async fetchIM(id: string, usernamesById: Map<string, string>) {
		const cc = Logger.getCorrelationContext();

		try {
			const response = await this.slackApiCall("conversations.info", {
				channel: id
			});

			const { ok, error, channel } = response as WebAPICallResult & { channel: any };
			if (!ok) throw new Error(error);

			// this._unreads.update(
			// 	channel.id,
			// 	channel.last_read,
			// 	channel.unread_count_display || 0,
			// 	channel.unread_count_display || 0
			// );

			return fromSlackDirect(channel, usernamesById, this._slackUserId, this._codestreamTeamId);
		} catch (ex) {
			Logger.error(ex, cc);
			throw ex;
		}
	}

	@log()
	async getStream(request: GetStreamRequest) {
		// if (request.type === StreamType.File) {
		// 	return this._codestream.getStream(request);
		// }

		let stream;
		switch (fromSlackChannelIdToType(request.streamId)) {
			case "channel":
				stream = await this.fetchChannel(request.streamId);
				break;
			case "group":
				stream = await this.fetchGroup(request.streamId, await this.ensureUsernamesById());
				break;
			case "direct":
				stream = await this.fetchIM(request.streamId, await this.ensureUsernamesById());
				break;
			default:
				throw new Error(`Invalid stream type: ${request.streamId}`);
		}

		return { stream: stream };
	}

	private _userIdMap: Map<string, string> | undefined;
	convertUserIdToCodeStreamUserId(id: string): string {
		if (this._userIdMap === undefined) return id;

		return this._userIdMap.get(id) || id;
	}

	private async getSlackPreferences() {
		// Use real-time events as a proxy for limited-slack mode (which can't use undocumented apis)
		// if (!this.capabilities.providerSupportsRealtimeEvents) {
		return { muted_channels: "" };
		// }

		// try {
		// 	// Undocumented API: https://github.com/ErikKalkoken/slackApiDoc/blob/master/users.prefs.get.md
		// 	const response = await this.slackApiCall("users.prefs.get", undefined);

		// 	const { ok, error, prefs } = response as WebAPICallResult & { prefs: any };
		// 	if (!ok) {
		// 		Logger.error(new Error(error));
		// 		return { muted_channels: "" };
		// 	}

		// 	return prefs as { [key: string]: any };
		// } catch (ex) {
		// 	Logger.error(ex);
		// 	return { muted_channels: "" };
		// }
	}

	private async getMeCore(meResponse?: CSGetMeResponse) {
		if (meResponse === undefined) {
			meResponse = await this._codestream.getMe();
		}

		// Only get the data if we already have it cached (otherwise we'll loop infinitely 😀)
		const { users } = SessionContainer.instance();
		const prevMe = users.cached
			? ((await users.getByIdFromCache(this._slackUserId)) as CSMe)
			: undefined;

		let me = meResponse.user;
		me.codestreamId = me.id;
		me.id = this.userId;

		const response = await this.slackApiCall("users.info", {
			user: this.userId
		});

		let user;

		const { ok, user: usr } = response as WebAPICallResult & { user: any };
		if (ok) {
			// Don't need to pass the codestream users here, since we set the codestreamId already above
			user = fromSlackUser(usr, this._codestreamTeamId, []);
			me = {
				...me,
				avatar: user.avatar,
				// creatorId: user.id,
				deactivated: user.deactivated,
				email: user.email || me.email,
				firstName: user.firstName,
				fullName: user.fullName,
				id: user.id,
				lastName: user.lastName,
				username: user.username,
				presence: prevMe && prevMe.presence
			};
		}

		if (me.lastReads == null) {
			me.lastReads = {};
		}

		try {
			const { muted_channels } = await this.getSlackPreferences();

			// Don't update our prefs, since they aren't per-team
			// void this.updatePreferences({
			// 	preferences: {
			// 		$set: { mutedStreams: mutedStreams }
			// 	}
			// });

			me.preferences = {
				...me.preferences,
				mutedStreams: muted_channels
					.split(",")
					.reduce((result: object, streamId: string) => ({ ...result, [streamId]: true }), {})
			};
		} catch (ex) {
			Logger.error(ex);
		}

		SessionContainer.instance().users.resolve({ type: MessageType.Users, data: [me] });

		return { user: me };
	}

	@log()
	async fetchUsers(): Promise<FetchUsersResponse> {
		const cc = Logger.getCorrelationContext();

		const [responses, { user: me }, { users: codestreamUsers }] = await Promise.all([
			this.slackApiCallPaginated("users.list", { limit: 1000 }),
			this.getMeCore(),
			(this._codestreamTeam !== undefined
				? Promise.resolve({ team: this._codestreamTeam })
				: this._codestream.getTeam({ teamId: this._codestreamTeamId })
			).then(({ team }) =>
				this._codestream.fetchUsers({
					userIds: team.memberIds
				})
			)
		]);

		const members = [];
		for await (const response of responses) {
			const { ok, error, members: data } = response as WebAPICallResult & {
				members: any[];
			};
			if (!ok) throw new Error(error);

			Logger.log(
				cc,
				`Fetched page; cursor=${response.response_metadata &&
					response.response_metadata.next_cursor}`
			);

			members.push(...data);
		}

		const users: CSUser[] = members.map((m: any) =>
			// Find ourselves and replace it with our model
			m.id === this._slackUserId ? me : fromSlackUser(m, this._codestreamTeamId, codestreamUsers)
		);
		// Don't filter out deactivated users anymore to allow codemark by deleted users to show up properly
		// .filter(u => !u.deactivated);

		this._userIdMap = new Map(
			users
				.filter(u => u.codestreamId !== undefined)
				.map<[string, string]>(u => [u.codestreamId!, u.id])
		);

		return { users: users };
	}

	// @log()
	// async getUser(request: GetUserRequest) {
	// 	if (request.userId === this.userId) {
	// 		return this.getMe();
	// 	}

	// 	// HACK: Forward to CodeStream if this isn't a slack user id
	// 	if (!request.userId.startsWith("U") && !request.userId.startsWith("W")) {
	// 		return this._codestream.getUser(request);
	// 	}

	// 	const [response, { users: codestreamUsers }] = await Promise.all([
	// 		this.slackApiCall("users.info", {
	// 			user: request.userId
	// 		}),
	// 		(this._codestreamTeam !== undefined
	// 			? Promise.resolve({ team: this._codestreamTeam })
	// 			: this._codestream.getTeam({ teamId: this._codestreamTeamId })
	// 		).then(({ team }) =>
	// 			this._codestream.fetchUsers({
	// 				userIds: team.memberIds
	// 			})
	// 		)
	// 	]);

	// 	const { ok, error, user: usr } = response as WebAPICallResult & { user: any };
	// 	if (!ok) throw new Error(error);

	// 	const user = fromSlackUser(usr, this._codestreamTeamId, codestreamUsers);

	// 	return { user: user };
	// }

	@debug({
		args: false,
		prefix: (context, method, request) =>
			`${context.prefix} ${method}(${
				request != null
					? Logger.toLoggable(request, (key, value) =>
							logFilterKeys.has(key) ? `<${key}>` : Logger.sanitize(key, value)
					  )
					: ""
			})`
	})
	protected async slackApiCall<
		TRequest extends WebAPICallOptions,
		TResponse extends WebAPICallResult
	>(method: string, request?: TRequest): Promise<TResponse> {
		const cc = Logger.getCorrelationContext();

		const timeoutMs = 30000;
		try {
			const response = await Functions.cancellable(
				this._slack.apiCall(method, request),
				timeoutMs,
				{
					cancelMessage: cc && cc.prefix,
					onDidCancel: () => Logger.warn(cc, `TIMEOUT ${timeoutMs / 1000}s exceeded`)
				}
			);

			if (Container.instance().agent.recordRequests) {
				const now = Date.now();
				// const { method, body } = init;

				const fs = require("fs");
				const sanitize = require("sanitize-filename");
				const sanitizedMethod = sanitize(
					method
					// .split("?")[0]
					// .replace(/\//g, "_")
					// .replace("_", "")
				);
				const filename = `/tmp/dump-${now}-slack-${sanitizedMethod}.json`;

				const out = {
					url: method,
					request: request,
					response: response
				};
				const outString = JSON.stringify(out, null, 2);

				fs.writeFile(filename, outString, "utf8", () => {
					Logger.log(`Written ${filename}`);
				});
			}

			return response as TResponse;
		} catch (ex) {
			Logger.error(ex, cc, ex.data != null ? JSON.stringify(ex.data) : undefined);
			throw ex;
		}
	}

	@debug({
		args: false,
		prefix: (context, method, request) =>
			`${context.prefix} ${method}(${
				request != null
					? Logger.toLoggable(request, (key, value) =>
							logFilterKeys.has(key) ? `<${key}>` : Logger.sanitize(key, value)
					  )
					: ""
			})`
	})
	protected async slackApiCallPaginated<
		TRequest extends WebAPICallOptions,
		TResponse extends WebAPICallResult
	>(method: string, request: TRequest): Promise<AsyncIterableIterator<TResponse>> {
		const cc = Logger.getCorrelationContext();

		try {
			const response = this._slack.paginate(method, request);
			return response as AsyncIterableIterator<TResponse>;
		} catch (ex) {
			Logger.error(ex, cc, ex.data != null ? JSON.stringify(ex.data) : undefined);
			throw ex;
		}
	}

	async dispose() {
		// await this._codestream.dispose();
		// if (this._events !== undefined) {
		// 	await this._events.dispose();
		// }
	}
}

const logFilterKeys = new Set(["text", "attachments"]);
