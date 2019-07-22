import { Range } from "vscode-languageserver-types";
import {
	CodemarkPlus,
	FetchAssignableUsersRequestType,
	GetRangeScmInfoRequestType,
	GetRangeScmInfoResponse,
	CreateDocumentMarkerPermalinkRequestType,
	ThirdPartyProviderBoard,
	ThirdPartyProviderConfig
} from "@codestream/protocols/agent";
import {
	CodemarkType,
	CSChannelStream,
	CSCodemark,
	CSDirectStream,
	CSStream,
	CSUser,
	StreamType
} from "@codestream/protocols/api";
import cx from "classnames";
import * as paths from "path-browserify";
import React from "react";
import { connect } from "react-redux";
import Select from "react-select";
import {
	getStreamForId,
	getStreamForTeam,
	getChannelStreamsForTeam,
	getDirectMessageStreamsForTeam,
	getDMName
} from "../store/streams/reducer";
import { Stream } from "../store/streams/types";
import { mapFilter, arrayToRange, forceAsLine, isRangeEmpty, toMapBy, replaceHtml } from "../utils";
import { HostApi } from "../webview-api";
import Button from "./Button";
import CrossPostIssueControls from "./CrossPostIssueControls";
import { CardValues } from "./CrossPostIssueControls/types";
import Tag from "./Tag";
import Icon from "./Icon";
import Menu from "./Menu";
import Tooltip from "./Tooltip";
import { sortBy as _sortBy, sortBy } from "lodash-es";
import { EditorSelectRangeRequestType, EditorSelection } from "@codestream/protocols/webview";
import { getCurrentSelection } from "../store/editorContext/reducer";
import Headshot from "./Headshot";
import { getTeamMembers, getTeamTags } from "../store/users/reducer";
import MessageInput from "./MessageInput";
import { getSlashCommands } from "./SlashCommands";
import { getCurrentTeamProvider } from "../store/teams/actions";

interface Props extends DispatchProps {
	streamId: string;
	collapseForm?: Function;
	onSubmit: Function;
	onClickClose(): any;
	openCodemarkForm?(type: string): any;
	slackInfo?: {};
	codeBlock?: GetRangeScmInfoResponse;
	commentType?: string;
	collapsed: boolean;
	isEditing?: boolean;
	editingCodemark?: CodemarkPlus;
	placeholder?: string;
	onDidChangeSelection?(location: EditorSelection): void;
}

interface DispatchProps {
	teammates: CSUser[];
	channelStreams: CSChannelStream[];
	directMessageStreams: CSDirectStream[];
	channel: Stream;
	issueProvider?: ThirdPartyProviderConfig;
	providerInfo: {
		[service: string]: {};
	};
	currentUser: CSUser;
	selectedStreams: {};
	showChannels: string;
	textEditorUri?: string;
	textEditorSelection?: EditorSelection;
	slashCommands: any[];
	services: {};
	teamProvider: "codestream" | "slack" | "msteams" | string;
	teamTags: any;
}

interface State {
	text: string;
	type: string;
	codeBlock?: GetRangeScmInfoResponse;
	assignees: { value: any; label: string }[] | { value: any; label: string };
	assigneesRequired: boolean;
	assigneesDisabled: boolean;
	singleAssignee: boolean;
	privacy: "private" | "public";
	notify: boolean;
	isLoading: boolean;
	crossPostMessage: boolean;
	assignableUsers: { value: any; label: string }[];
	channelMenuOpen: boolean;
	channelMenuTarget: any;
	labelMenuOpen: boolean;
	labelMenuTarget: any;
	selectedChannelName?: string;
	selectedChannelId?: string;
	title?: string;
	codeBlockInvalid?: boolean;
	titleInvalid?: boolean;
	textInvalid?: boolean;
	assigneesInvalid?: boolean;
	showAllChannels?: boolean;
	linkURI?: string;
	copied: boolean;
	selectedTags?: any;
	relatedCodemarkIds?: any;
}

function merge(defaults: Partial<State>, codemark: CSCodemark): State {
	return Object.entries(defaults).reduce((object, entry) => {
		const [key, value] = entry;
		object[key] = codemark[key] !== undefined ? codemark[key] : value;
		return object;
	}, Object.create(null));
}

class CodemarkForm extends React.Component<Props, State> {
	static defaultProps = {
		commentType: "comment",
		isEditing: false
	};
	tabIndexCount = 0;
	_titleInput: HTMLElement | null = null;
	insertTextAtCursor?: Function;
	focusOnMessageInput?: Function;
	crossPostIssueValues?: CardValues;
	permalinkRef = React.createRef<HTMLTextAreaElement>();

	constructor(props: Props) {
		super(props);
		const defaultType = props.commentType;
		const defaultState: Partial<State> = {
			title: "",
			text: "",
			type: defaultType,
			codeBlock: props.codeBlock,
			assignees: [],
			assigneesDisabled: false,
			assigneesRequired: false,
			singleAssignee: false,
			selectedChannelName: props.channel.name,
			selectedChannelId: props.channel.id,
			assignableUsers: this.getAssignableCSUsers(),
			privacy: "private",
			selectedTags: {},
			relatedCodemarkIds: {}
		};

		const state = props.editingCodemark
			? merge(defaultState, props.editingCodemark)
			: ({
					isLoading: false,
					notify: false,
					...defaultState
			  } as State);

		let assignees: any;
		if (props.isEditing) {
			const externalAssignees = this.props.editingCodemark!.externalAssignees || [];
			assignees = externalAssignees
				.map(a => ({
					value: a.displayName,
					label: a.displayName
				}))
				.concat(
					mapFilter(this.props.editingCodemark!.assignees || [], a =>
						state.assignableUsers.find((au: any) => au.value === a)
					)
				);
		} else if (state.assignees === undefined) {
			assignees = undefined;
		} else if (Array.isArray(state.assignees)) {
			assignees = state.assignees.map(a => state.assignableUsers.find((au: any) => au.value === a));
		} else {
			assignees = state.assignableUsers.find((au: any) => au.value === state.assignees);
		}
		this.state = {
			...state,
			assignees
		};
	}

	static getDerivedStateFromProps(props: Props, state: State) {
		// revisit this if the ability to change the type is added back to the form
		// TODO: this should call ComposeBox.repositionIfNecessary()
		if (props.commentType !== state.type) {
			return { type: props.commentType };
		}
		return null;
	}

	componentDidMount() {
		const { codeBlock } = this.state;
		if (codeBlock) {
			if (isRangeEmpty(codeBlock.range)) {
				this.selectRangeInEditor(codeBlock.uri, forceAsLine(codeBlock.range));
			}
			this.handleScmChange();
		} else {
			const { textEditorSelection, textEditorUri } = this.props;
			if (textEditorSelection && textEditorUri) {
				// In case there isn't already a range selection by user, change the selection to be the line the cursor is on
				const isEmpty = isRangeEmpty(textEditorSelection);
				const range = isEmpty ? forceAsLine(textEditorSelection) : textEditorSelection;
				if (isEmpty) this.selectRangeInEditor(textEditorUri, range);
				this.getScmInfoForSelection(textEditorUri, range);
			}
		}
		this.focus();
	}

	componentDidUpdate(prevProps: Props) {
		const { isEditing, textEditorSelection, textEditorUri } = this.props;
		if (
			prevProps.textEditorSelection !== textEditorSelection &&
			!isEditing &&
			!this.state.linkURI
		) {
			this.getScmInfoForSelection(textEditorUri!, forceAsLine(textEditorSelection!));
			this.props.onDidChangeSelection && this.props.onDidChangeSelection(textEditorSelection!);
		}

		const prevProviderHost = prevProps.issueProvider ? prevProps.issueProvider.host : undefined;
		const providerHost = this.props.issueProvider ? this.props.issueProvider.host : undefined;
		if (prevProviderHost !== providerHost) {
			this.setState({
				assignableUsers: this.getAssignableCSUsers(),
				assignees: [],
				assigneesDisabled: false,
				assigneesRequired: false,
				singleAssignee: false
			});
			this.crossPostIssueValues = undefined;
		}
	}

	private selectRangeInEditor(uri: string, range: Range) {
		HostApi.instance.send(EditorSelectRangeRequestType, {
			uri: uri,
			selection: { ...range, cursor: range.end },
			preserveFocus: true
		});
	}

	private async getScmInfoForSelection(uri: string, range: Range) {
		const scmInfo = await HostApi.instance.send(GetRangeScmInfoRequestType, {
			uri: uri,
			range: range,
			dirty: true // should this be determined here? using true to be safe
		});
		this.setState({ codeBlock: scmInfo }, () => {
			this.handleScmChange();
		});
	}

	getAssignableCSUsers() {
		return mapFilter(this.props.teammates, user => {
			if (!user.isRegistered) return;
			return {
				value: user.id,
				label: user.username
			};
		});
	}

	async loadAssignableUsers(providerId: string, board: ThirdPartyProviderBoard) {
		if (board.assigneesDisabled) return this.setState({ assigneesDisabled: true });
		if (board.assigneesRequired) {
			this.setState(state => (state.assigneesRequired ? null : { assigneesRequired: true }));
		}
		if (board.singleAssignee) {
			this.setState(state => (state.singleAssignee ? null : { singleAssignee: true }));
		}

		try {
			const { users } = await HostApi.instance.send(FetchAssignableUsersRequestType, {
				providerId,
				boardId: board.apiIdentifier || board.id
			});

			this.setState({
				assignableUsers: users.map(u => ({
					value: u,
					label: u.displayName
				}))
			});
		} catch (error) {
			this.setState({ assignableUsers: [] });
		}
	}

	handleCrossPostIssueValues = (values: CardValues) => {
		const selectedNewBoard = Boolean(values.board);
		if (values.isEnabled) {
			// new settings enable cross posting
			if (
				(this.crossPostIssueValues && !this.crossPostIssueValues.isEnabled) || // cross posting was disabled before OR...
				(selectedNewBoard && // there is a new board and...
					(!this.crossPostIssueValues || values.board !== this.crossPostIssueValues!.board)) // didn't have values before || new board is different
			) {
				this.setState({ assignees: [] }); // reset selected assignees because they may not be valid with the new board
				this.loadAssignableUsers(values.issueProvider.id, values.board!);
			}
		} else if (this.crossPostIssueValues && this.crossPostIssueValues.isEnabled) {
			// cross posting is now disabled so reset selected assignees and show cs options
			this.setState({ assignees: [], assignableUsers: this.getAssignableCSUsers() });
		}
		this.crossPostIssueValues = values;
	};

	handleSelectionChange = () => {
		const { textEditorSelection, textEditorUri } = this.props;
		if (textEditorSelection) {
			this.getScmInfoForSelection(textEditorUri!, forceAsLine(textEditorSelection));
		}
	};

	handleScmChange = () => {
		const { codeBlock } = this.state;

		this.setState({ codeBlockInvalid: false });

		if (!codeBlock) return;

		let mentions: Record<"id" | "username", string>[] = [];
		if (codeBlock.scm && codeBlock.scm.authors) {
			mentions = codeBlock.scm.authors.filter(author => author.id !== this.props.currentUser.id);
		}

		if (mentions.length > 0) {
			// TODO handle users with no username
			const usernames: string[] = mentions.map(u => `@${u.username}`);
			// if there's text in the compose area, return without
			// adding the suggestion
			if (this.state.text.length > 0) return;
			// the reason for this unicode space is that chrome will
			// not render a space at the end of a contenteditable div
			// unless it is a &nbsp;, which is difficult to insert
			// so we insert this unicode character instead
			this.focusOnMessageInput &&
				this.focusOnMessageInput(() => {
					this.insertTextAtCursor && this.insertTextAtCursor(usernames.join(", ") + ":\u00A0");
				});
		}
	};

	// TODO: remove this
	tabIndex = () => {
		return 0;
	};

	// TODO: work on this from initial mount
	focus = (forceMainInput = false) => {
		// if (forceMainInput && this._contentEditable) return this._contentEditable.htmlEl.focus();

		switch (this.state.type) {
			case "question":
			case "issue":
			case "bookmark":
				this._titleInput && this._titleInput.focus();
				break;
			case "snippet":
			case "comment":
			default:
				this.focusOnMessageInput && this.focusOnMessageInput();
		}
	};

	// onSelectCodemarkType = (type?: string) => {
	// 	this.setState({ menuOpen: false });
	// 	if (type) this.setCommentType(type);
	// }

	setCommentType = (type: string) => {
		if (this.props.editingCodemark) return;
		this.setState({
			type,
			codeBlockInvalid: false,
			titleInvalid: false,
			textInvalid: false
		});
		// setTimeout(() => {
		// 	// this.focus();
		// }, 20);
	};

	togglePrivacy = () => {
		this.setState(state => ({ privacy: state.privacy === "public" ? "private" : "public" }));
	};

	toggleNotify = () => {
		this.setState({ notify: !this.state.notify });
	};

	toggleCrossPostMessage = () => {
		this.setState(state => ({ crossPostMessage: !state.crossPostMessage }));
	};

	handleClickSubmit = async (event?: React.SyntheticEvent) => {
		event && event.preventDefault();
		if (this.isFormInvalid()) return;

		const {
			codeBlock,
			privacy,
			type,
			title,
			text,
			selectedChannelId,
			selectedTags,
			relatedCodemarkIds
		} = this.state;

		if (type === "link") {
			let request;
			if (codeBlock) {
				request = {
					uri: codeBlock.uri,
					range: codeBlock.range,
					privacy: privacy
				};
			} else {
				request = {
					uri: this.props.textEditorUri,
					range: this.props.textEditorSelection,
					privacy: privacy
				};
			}

			this.setState({ isLoading: true });

			const response = await HostApi.instance.send(
				CreateDocumentMarkerPermalinkRequestType,
				request
			);
			this.setState({ linkURI: response.linkUrl, isLoading: false });

			return;
		}

		const crossPostIssueEnabled =
			type === CodemarkType.Issue &&
			this.crossPostIssueValues &&
			this.crossPostIssueValues.isEnabled;

		let csAssignees: string[] = [];
		if (crossPostIssueEnabled) {
			const assignees = Array.isArray(this.state.assignees)
				? this.state.assignees
				: [this.state.assignees];

			csAssignees = mapFilter(assignees, a => {
				const user = a.value;
				const codestreamUser = this.props.teammates.find(
					t => Boolean(user.email) && t.email === user.email
				);
				if (codestreamUser) return codestreamUser.id;
				return undefined;
			});
			this.crossPostIssueValues!.assignees = assignees.map(a => a.value);
		} else
			csAssignees = this.props.isEditing
				? this.props.editingCodemark!.assignees
				: (this.state.assignees as any[]).map(a => a.value);

<<<<<<< HEAD
<<<<<<< HEAD
		this.setState({ isLoading: true });
		try {
			await this.props.onSubmit(
				{
					codeBlock: this.state.codeBlock,
					streamId: selectedChannelId,
					text: replaceHtml(text)!,
					color,
					type,
					assignees: csAssignees,
					title,
					crossPostIssueValues: crossPostIssueEnabled ? this.crossPostIssueValues : undefined
					// notify,
					// crossPostMessage,
				},
				event
			);
		} catch (error) {
		} finally {
			this.setState({ isLoading: false });
		}
=======
=======
		let tags: string[] = [];
		for (const [key, value] of Object.entries(selectedTags)) {
			if (value) tags.push(key);
		}

>>>>>>> remove confusing (and incorrect) definition of codmark tags attribute
		this.props.onSubmit(
			{
				codeBlock: this.state.codeBlock,
				streamId: selectedChannelId,
				text: replaceHtml(text)!,
				type,
				assignees: csAssignees,
				title,
				crossPostIssueValues: crossPostIssueEnabled ? this.crossPostIssueValues : undefined,
				tags,
				relatedCodemarkIds
				// notify,
				// crossPostMessage,
			},
			event
		);
>>>>>>> remove react warnings on codemark form
	};

	isFormInvalid = () => {
		const { codeBlock } = this.state;
		const { text, title, assignees, assigneesRequired, type } = this.state;

		const validationState = {
			codeBlockInvalid: false,
			titleInvalid: false,
			textInvalid: false,
			assigneesInvalid: false
		};

		let invalid = false;
		if (type === "trap" || type === "bookmark") {
			if (!codeBlock) {
				validationState.codeBlockInvalid = true;
				invalid = true;
			}
		}
		if (type === "question" || type === "issue") {
			if (!title || title.length === 0) {
				validationState.titleInvalid = true;
				invalid = true;
			}
			if (
				assigneesRequired &&
				(!assignees || (Array.isArray(assignees) && assignees.length === 0))
			) {
				invalid = validationState.assigneesInvalid = true;
			}
		}
		if (type === "comment" || type === "trap") {
			if (text.length === 0) {
				validationState.textInvalid = true;
				invalid = true;
			}
		}

		this.setState(validationState);
		return invalid;
	};

	showAlertHelp = event => {
		event.stopPropagation();
	};

	renderTitleHelp = () => {
		const { titleInvalid } = this.state;

		if (titleInvalid) {
			return <small className="error-message">Required</small>;
		} else return null;
	};

	renderTextHelp = () => {
		const { textInvalid } = this.state;

		if (textInvalid) {
			return <small className="error-message">Required</small>;
		} else return null;
	};

	switchChannel = (event: React.SyntheticEvent) => {
		if (this.props.isEditing) return;

		event.stopPropagation();
		const target = event.target;
		this.setState(state => ({
			channelMenuOpen: !state.channelMenuOpen,
			channelMenuTarget: target,
			crossPostMessage: true
		}));
	};

	selectChannel = (stream: Stream | "show-all") => {
		if (stream === "show-all") {
			this.setState({ showAllChannels: true });
			return;
		} else if (stream && stream.id) {
			const channelName = (stream.type === StreamType.Direct ? "@" : "#") + stream.name;
			this.setState({ selectedChannelName: channelName, selectedChannelId: stream.id });
		}
		this.setState({ channelMenuOpen: false });
	};

	switchLabel = (event: React.SyntheticEvent) => {
		event.stopPropagation();
		const target = event.target;
		this.setState(state => ({
			labelMenuOpen: !state.labelMenuOpen,
			labelMenuTarget: target
		}));
	};

	// selectLabel = (color: string) => {
	// 	this.setState({ color: color, labelMenuOpen: false });
	// };

	// handleClickConnectSlack = async event => {
	// 	event.preventDefault();
	// 	this.setState({ isLoading: true });
	// 	await HostApi.instance.send(GoToSlackSignin); // TODO: use the provider api
	// 	this.setState({ isLoading: false });
	// }

	renderTags = () => {
		const { selectedTags } = this.state;
		const keys = Object.keys(selectedTags);
		if (keys.length === 0) return null;

		console.log("TEAM TAGS ARE: ", this.props.teamTags);
		return (
			<div className="tags" key="tags" style={{ margin: "10px 0 -10px 0" }}>
				{this.props.teamTags.map(tag => {
					return selectedTags[tag.id] ? <Tag tag={tag} /> : null;
				})}
				<div style={{ clear: "both" }} />
			</div>
		);
	};

	renderRelatedCodemarks = () => {
		const { relatedCodemarkIds } = this.state;
		const keys = Object.keys(relatedCodemarkIds);
		if (keys.length === 0) return null;

		return (
			<div className="related-codemarks" key="related-codemarks" style={{ margin: "10px 0 0 0" }}>
				{keys.map(key => {
					const codemark = relatedCodemarkIds[key];
					if (!codemark) return null;

					const title = codemark.title || codemark.text;
					const icon = (
						<Icon
							name={codemark.type || "comment"}
							className={`${codemark.color}-color type-icon`}
						/>
					);
					const file = codemark.markers && codemark.markers[0] && codemark.markers[0].file;

					return (
						<div key={key} className="related-codemark">
							{icon}&nbsp;{title}&nbsp;&nbsp;<span className="codemark-file">{file}</span>
						</div>
					);
				})}
				<div style={{ clear: "both" }} />
			</div>
		);
	};

	renderCrossPostMessage = commentType => {
		const { selectedStreams, showChannels } = this.props;
		const { showAllChannels, selectedChannelId } = this.state;
		// if (this.props.slackInfo || this.props.providerInfo.slack) {
		const items: { label: string; action?: CSStream | "show-all"; key?: string }[] = [];

		// let labelMenuItems: any = [{ label: "None", action: "" }, { label: "-" }];

		// labelMenuItems = labelMenuItems.concat(
		// 	COLOR_OPTIONS.map(color => {
		// 		return {
		// 			label: (
		// 				<span className={`${color}-color`}>
		// 					<Icon name={commentType} /> {color}
		// 				</span>
		// 			),
		// 			action: color
		// 		};
		// 	})
		// );
		// labelMenuItems.push({ label: "-" });
		// labelMenuItems.push({ label: "Edit Labels", action: "edit" });

		let firstChannel;
		let selectedChannelName = "";
		const filterSelected = showChannels === "selected" && !showAllChannels;
		this.props.channelStreams.forEach(channel => {
			if (channel.isArchived || (filterSelected && !selectedStreams[channel.id])) return;

			if (channel.id === selectedChannelId) {
				selectedChannelName = channel.name!;
			}
			if (!firstChannel) {
				firstChannel = channel;
			}

			items.push({ label: `#${channel.name}`, action: channel, key: channel.id });
		});

		if (this.props.directMessageStreams.length > 0) {
			items.push({ label: "-" });

			let firstDM = items.length;

			const currentUserId = this.props.currentUser.id;
			_sortBy(this.props.directMessageStreams, (stream: CSDirectStream) =>
				(stream.name || "").toLowerCase()
			).forEach((channel: CSDirectStream) => {
				if (
					channel.isArchived ||
					channel.isClosed ||
					(filterSelected && !selectedStreams[channel.id])
				) {
					return;
				}

				if (channel.id === selectedChannelId) {
					selectedChannelName = channel.name!;
				}
				if (!firstChannel) {
					firstChannel = channel;
				}

				const item = { label: channel.name!, action: channel, key: channel.id };
				// Ensure Slackbot is first (if there), then your own DM
				if (channel.memberIds.length === 2 && channel.memberIds.includes("USLACKBOT")) {
					items.splice(firstDM, 0, item);
					firstDM++;
				} else if (channel.memberIds.length === 1 && channel.memberIds[0] === currentUserId) {
					items.splice(firstDM, 0, item);
				} else {
					items.push(item);
				}
			});
		}

		// if we don't have a name set here, that means you've filtered to a set
		// of streams that doesn't include your currently selected stream. so
		// we need to select it
		if (selectedChannelName.length === 0 && firstChannel) this.selectChannel(firstChannel);

		// if there is only 1 item, say #general,
		// in that case, the user hasn't added channels yet, or
		// invited users, so it's not helpful/useful to give them an option
		// they can't use.
		if (items.length === 1 && showChannels !== "selected") return null;

		if (filterSelected) {
			items.push({ label: "-" });
			items.push({ label: "Show All Channels & DMs", action: "show-all" });
		}

		return (
			<div key="crosspost" className="checkbox-row" style={{ float: "left" }}>
				{/*<input type="checkbox" checked={this.state.crossPostMessage} /> */} Post to{" "}
				<span className="channel-label" onClick={this.switchChannel}>
					{selectedChannelName}
					<Icon name="chevron-down" />
					{this.state.channelMenuOpen && (
						<Menu
							align="center"
							compact={true}
							target={this.state.channelMenuTarget}
							items={items}
							action={this.selectChannel}
						/>
					)}
				</span>
			</div>
		);
		// }
		// else {
		// 	return (
		// 		<div className="checkbox-row connect-messaging" onClick={this.toggleCrossPostMessage}>
		// 			Post to
		// 			<span className="service" onClick={this.handleClickConnectSlack}>
		// 				<Icon className="slack" name="slack" />
		// 				Slack
		// 			</span>
		// 			{this.state.isLoading && (
		// 				<span>
		// 					<Icon className="spin" name="sync" /> Syncing channels...
		// 				</span>
		// 			)}
		// 		</div>
		// 	);
		// }
	};

	handleChange = text => {
		// track newPostText as the user types
		this.setState({
			text
		});
	};

	getNextTagId = () => {
		return this.props.teamTags.length + 1;
	};

	handleChangeTag = newTag => {
		const newTagCopy = { ...newTag };
		if (newTag.id) {
			// TAGS.forEach((tag, index) => {
			// if (tag.id === newTag.id) TAGS[index] = newTagCopy;
			// });
		} else {
			// newTagCopy.id = TAGS.length + 1;
			// TAGS = TAGS.concat(newTagCopy);
		}
	};

	handleToggleTag = tagId => {
		if (!tagId) return;
		let selectedTags = this.state.selectedTags;
		selectedTags[tagId] = !selectedTags[tagId];
		this.setState({ selectedTags });
	};

	handleToggleCodemark = codemark => {
		if (!codemark || !codemark.id) return;
		let relatedCodemarkIds = this.state.relatedCodemarkIds;
		if (relatedCodemarkIds[codemark.id]) delete relatedCodemarkIds[codemark.id];
		else relatedCodemarkIds[codemark.id] = codemark;
		this.setState({ relatedCodemarkIds });
	};

	handleChangeRelated = codemarkIds => {
		this.setState({ relatedCodemarkIds: codemarkIds });
	};

	getCodeBlockHint() {
		const { editingCodemark } = this.props;
		const { codeBlock } = this.state;
		if (!codeBlock || !codeBlock.range) return "Select a range to comment on a block of code.";

		const scm = codeBlock.scm;
		let file = scm && scm.file ? paths.basename(scm.file) : "";

		let range: any = codeBlock.range;
		if (editingCodemark) {
			if (editingCodemark.markers) {
				const marker = editingCodemark.markers[0];
				if (marker.locationWhenCreated) {
					// TODO: location is likely invalid
					range = arrayToRange(marker.locationWhenCreated as any);
				} else {
					range = undefined;
				}
				file = marker.file || "";
			}
		}

		let lines: string;
		if (range === undefined) lines = "";
		else if (range.start.line === range.end.line) {
			lines = `(Line ${range.start.line + 1})`;
		} else {
			lines = `(Lines ${range.start.line + 1}-${range.end.line + 1})`;
		}

		const commentType = editingCodemark ? editingCodemark.type : this.state.type;
		const titleLabel =
			commentType === "issue"
				? "issue in "
				: commentType === "question"
				? "question in "
				: commentType === "bookmark"
				? "bookmark in "
				: commentType === "link"
				? "permalink for "
				: commentType === "comment"
				? "comment in "
				: "";

		return titleLabel + file + " " + lines;
	}

	renderMessageInput = () => {
		const { codeBlock, type, text } = this.state;
		let placeholder = this.props.placeholder;

		if (codeBlock) {
			// const range = codeBlock ? arrayToRange(codeBlock.location) : null;
			// let rangeText = "";
			// if (range && codeBlock && codeBlock.file) {
			// 	rangeText += "Add comment for " + codeBlock.file;
			// 	const endLine = range.end.col == 0 ? range.end.row : range.end.row + 1;
			// 	if (range.start.row + 1 === endLine) {
			// 		rangeText += " line " + (range.start.row + 1);
			// 	} else {
			// 		rangeText += " lines " + (range.start.row + 1) + "-" + endLine;
			// 	}
			// 	// placeholder = rangeText;
			// }
			if (type === "question") placeholder = "Answer (optional)";
			else if (type === "issue") placeholder = "Description (optional)";
			else placeholder = "";
		}

		const __onDidRender = ({ insertTextAtCursor, focus }) => {
			this.insertTextAtCursor = insertTextAtCursor;
			this.focusOnMessageInput = focus;
		};

		return (
			<MessageInput
				teammates={this.props.teammates}
				currentUserId={this.props.currentUser.id}
				slashCommands={this.props.slashCommands}
				services={this.props.services}
				channelStreams={this.props.channelStreams}
				teamProvider={this.props.teamProvider}
				isDirectMessage={this.props.channel.type === StreamType.Direct}
				text={text.replace(/\n/g, "<br/>")}
				placeholder={placeholder}
				multiCompose
				onChange={this.handleChange}
				toggleTag={this.handleToggleTag}
				toggleCodemark={this.handleToggleCodemark}
				onSubmit={this.handleClickSubmit}
				teamTags={this.props.teamTags}
				selectedTags={this.state.selectedTags}
				relatedCodemarkIds={this.state.relatedCodemarkIds}
				__onDidRender={__onDidRender}
			/>
		);
	};

	copyPermalink = (event: React.SyntheticEvent) => {
		event.preventDefault();
		if (this.permalinkRef.current) {
			this.permalinkRef.current.select();
			document.execCommand("copy");
			this.setState({ copied: true });
		}
	};

	render() {
		const { editingCodemark, currentUser } = this.props;
		const commentType = editingCodemark ? editingCodemark.type : this.state.type || "comment";

		const titlePlaceholder =
			commentType === "issue"
				? "Title (required)"
				: commentType === "question"
				? "Question (required)"
				: commentType === "bookmark"
				? "Bookmark Name (optional)"
				: "Title (optional)";

		const assigneesPlaceholder = this.props.providerInfo["trello"]
			? "Members (optional)"
			: "Assignees (optional)";

		const modifier = navigator.appVersion.includes("Macintosh") ? "⌘" : "Alt";

		const submitTip =
			commentType === "link" ? (
				this.state.copied ? (
					"Copied!"
				) : this.state.linkURI ? (
					"Copy Link"
				) : (
					"Create Link"
				)
			) : commentType === "issue" ? (
				"Create Issue"
			) : commentType === "bookmark" ? (
				"Create Bookmark"
			) : (
				<span>
					Submit Comment<span className="keybinding extra-pad">{modifier} ENTER</span>
				</span>
			);

		const cancelTip = (
			<span>
				Discard Comment<span className="keybinding extra-pad">ESC</span>
			</span>
		);

		return [
			<form
				id="code-comment-form"
				className={cx("codemark-form", "standard-form", { "google-style": true })}
				key="two"
			>
			<form id="code-comment-form" className="standard-form" key="two">
				<fieldset className="form-body">
					<div id="controls" className="control-group" key="controls1">
						<div
							key="headshot"
							style={{
								paddingLeft: "25px",
								height: "25px",
								marginTop: "10px",
								marginBottom: "12px",
								display: "inline-flex"
							}}
						>
							<Headshot person={currentUser} />
							<b>{currentUser.username}</b>
							<span style={{ opacity: 0.75, paddingLeft: "5px" }}>{this.getCodeBlockHint()}</span>
						</div>
						{commentType === "trap" && (
							<div className="hint frame control-group" style={{ marginBottom: "10px" }}>
								{trapTip}
							</div>
						)}
						{/* false && commentType === "bookmark" && (
							<div className="hint frame control-group" style={{ marginBottom: "10px" }}>
								{bookmarkTip}
							</div>
						) */}
						{commentType === "issue" && !this.props.isEditing && (
							<CrossPostIssueControls
								onValues={this.handleCrossPostIssueValues}
								codeBlock={this.state.codeBlock as any}
							/>
						)}
						{(commentType === "issue" ||
							commentType === "question" ||
							commentType === "bookmark" ||
							commentType === "snippet") && (
							<div key="title" className="control-group">
								{this.renderTitleHelp()}
								<input
									key="title-text"
									type="text"
									name="title"
									className="input-text control"
									tabIndex={this.tabIndex()}
									value={this.state.title}
									onChange={e => this.setState({ title: e.target.value })}
									placeholder={titlePlaceholder}
									ref={ref => (this._titleInput = ref)}
								/>
							</div>
						)}
						{commentType === "issue" && (
							<div
								key="members"
								id="members-controls"
								className="control-group"
								style={{ marginBottom: "10px" }}
							>
								{!this.state.assigneesDisabled && !this.props.isEditing && (
									<Select
										key="input-assignees"
										id="input-assignees"
										name="assignees"
										classNamePrefix="react-select"
										isMulti={!this.state.singleAssignee}
										value={this.state.assignees}
										options={this.state.assignableUsers}
										closeMenuOnSelect={true}
										isClearable={false}
										placeholder={assigneesPlaceholder}
										onChange={value => this.setState({ assignees: value! })}
										tabIndex={this.tabIndex().toString()}
									/>
								)}
								{this.props.isEditing && (
									<Select
										key="input-assignees2"
										id="input-assignees"
										name="assignees"
										classNamePrefix="react-select"
										isMulti
										isDisabled
										value={this.state.assignees}
									/>
								)}
							</div>
						)}
						{this.renderTextHelp()}
						{this.state.linkURI &&
							this.state.privacy === "public" && [
								<div key="permalink-warning" className="permalink-warning">
									<Icon name="alert" />
									Note that this is a public URL. Anyone with the link will be able to see the
									quoted code snippet.
								</div>
							]}
						{this.state.linkURI && [
							<textarea
								key="link-offscreen"
								ref={this.permalinkRef}
								value={this.state.linkURI}
								style={{ position: "absolute", left: "-9999px" }}
							/>,
							<input type="text" className="permalink" value={this.state.linkURI} />
						]}
						{commentType === "link" && !this.state.linkURI && (
							<div id="privacy-controls" className="control-group" key="1">
								<div className="public-private-hint" key="privacy-hint">
									{this.state.privacy === "private"
										? "Only members of your team can access this link."
										: "Anyone can view this link, including quoted codeblock."}
								</div>
								<div
									key="privacy"
									className={cx("switch public-private", {
										checked: this.state.privacy === "private"
									})}
									onClick={this.togglePrivacy}
								/>
							</div>
						)}
						{commentType !== "bookmark" && commentType !== "link" && this.renderMessageInput()}
					</div>
					{false && (commentType === "comment" || commentType === "question") && (
						<div key="alert" className="checkbox-row" onClick={this.toggleNotify}>
							<input type="checkbox" checked={this.state.notify} /> Alert me if someone edits code
							in this range{"  "}
							<Tooltip title="Click to learn more">
								<span>
									<Icon className="clickable" onClick={this.showAlertHelp} name="info" />
								</span>
							</Tooltip>
						</div>
					)}
					{commentType === "issue" && !this.props.isEditing && (
						<CrossPostIssueControls
							onValues={this.handleCrossPostIssueValues}
							codeBlock={this.state.codeBlock as any}
						/>
					)}
					{this.renderRelatedCodemarks()}
					{this.renderTags()}
					{commentType !== "link" && this.renderCrossPostMessage(commentType)}
					<div
						key="buttons"
						className="button-group"
						style={{
							marginLeft: "10px",
							marginTop: "10px",
							float: "right",
							width: "auto",
							marginRight: 0
						}}
					>
						<Tooltip title={cancelTip} placement="bottom" delay={1}>
							<Button
								key="cancel"
								style={{
									paddingLeft: "10px",
									paddingRight: "10px",
									width: "auto"
								}}
								className="control-button cancel"
								type="submit"
								onClick={this.props.onClickClose}
							>
								{this.state.copied ? "Close" : "Cancel"}
							</Button>
						</Tooltip>
						<Tooltip title={submitTip} placement="bottom" delay={1}>
							<Button
								key="submit"
								style={{
									paddingLeft: "10px",
									paddingRight: "10px",
									// fixed width to handle the isLoading case
									width: "80px",
									marginRight: 0
								}}
								className="control-button"
								type="submit"
								loading={this.state.isLoading}
								onClick={this.state.linkURI ? this.copyPermalink : this.handleClickSubmit}
							>
								{commentType === "link"
									? this.state.copied
										? "Copied!"
										: this.state.linkURI
										? "Copy Link"
										: "Create Link"
									: "Submit"}
							</Button>
						</Tooltip>
						{/*
							<span className="hint">Styling with Markdown is supported</span>
						*/}
					</div>
					<div key="clear" style={{ clear: "both" }} />
				</fieldset>
			</form>
		];
		// 	<span className="hixnt" style={{ grid: "none" }}>
		// 	<input type="checkbox" />
		// 	Open automatically on selection
		// </span>
		// 	<input
		// 	id="radio-comment-type-snippet"
		// 	type="radio"
		// 	name="comment-type"
		// 	checked={commentType === "snippet"}
		// 	onChange={e => this.setCommentType("snippet")}
		// />
		// <label
		// 	htmlFor="radio-comment-type-snippet"
		// 	className={createClassString({
		// 		checked: commentType === "snippet"
		// 	})}
		// >
		// 	<Icon name="code" /> <span>Snippet</span>
		// </label>
	}
}

const EMPTY_OBJECT = {};

const mapStateToProps = (state): DispatchProps => {
	const { context, editorContext, users, session, preferences, providers } = state;
	const user = users[session.userId];
	const channel = context.currentStreamId
		? getStreamForId(state.streams, context.currentTeamId, context.currentStreamId) ||
		  getStreamForTeam(state.streams, context.currentTeamId)
		: getStreamForTeam(state.streams, context.currentTeamId);

	const teammates = getTeamMembers(state);
	const teamTags = getTeamTags(state);

	const channelStreams: CSChannelStream[] = sortBy(
		(getChannelStreamsForTeam(
			state.streams,
			context.currentTeamId,
			session.userId
		) as CSChannelStream[]) || [],
		stream => (stream.name || "").toLowerCase()
	);

	const directMessageStreams: CSDirectStream[] = (
		getDirectMessageStreamsForTeam(state.streams, context.currentTeamId) || []
	).map(stream => ({
		...(stream as CSDirectStream),
		name: getDMName(stream, toMapBy("id", teammates), session.userId)
	}));

	return {
		channel,
		teammates,
		channelStreams: channelStreams,
		directMessageStreams: directMessageStreams,
		issueProvider: providers[context.issueProvider],
		providerInfo: (user.providerInfo && user.providerInfo[context.currentTeamId]) || EMPTY_OBJECT,
		teamProvider: getCurrentTeamProvider(state),
		currentUser: user,
		selectedStreams: preferences.selectedStreams || EMPTY_OBJECT,
		showChannels: context.channelFilter,
		textEditorUri: editorContext.textEditorUri,
		textEditorSelection: getCurrentSelection(editorContext),
		slashCommands: getSlashCommands(state.capabilities),
		services: state.services,
		teamTags
	};
};

const ConnectedCodemarkForm = connect(mapStateToProps)(CodemarkForm);

export { ConnectedCodemarkForm as CodemarkForm };
