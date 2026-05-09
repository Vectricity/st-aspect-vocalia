// ============================================================================
// ============================================================================
// SillyTavern Extension - Aspect: Vocalia                   created by Genisai
// ============================================================================
// ============================================================================

// ============================================================================
// Section 1. Imports
// ============================================================================
// Owns all external dependencies used by this extension file.
// ============================================================================

import {
    saveSettingsDebounced as importedSaveSettingsDebounced,
    deleteLastMessage as importedDeleteLastMessage,
} from '../../../../script.js';
import { getContext as importedGetContext } from '../../../extensions.js';

// ============================================================================
// Section 2. Module Constants and State
// ============================================================================
// Purpose:
// - Own stable identifiers, default settings, UI element IDs, and runtime state.
// - Keep all magic strings and extension-wide values centralized.
// - Track trigger attempts, pending assistant-message waits, and active targets.
// ============================================================================

const MODULE_NAME = 'aspect_vocalia';
const MODULE_DISPLAY_NAME = 'Aspect: Vocalia';
const LEGACY_MODULE_NAMES = ['group_speaker_router'];

const GROUP_ACTIVATION_MANUAL = 2;
const EXTENSION_PROMPT_POSITION_IN_CHAT = 1;
const EXTENSION_PROMPT_ROLE_SYSTEM = 0;

const ARRIVAL_APPLY_IMMEDIATE = 'immediate';
const ARRIVAL_APPLY_DEFERRED = 'deferred';

const FIRST_MESSAGE_FALLBACK_RANDOM_PRESENT = 'random_present';
const FIRST_MESSAGE_FALLBACK_FIRST_PRESENT = 'first_present';
const FIRST_MESSAGE_FALLBACK_DO_NOTHING = 'do_nothing';

const MEMBER_STATUS_PRESENT = 'present';
const MEMBER_STATUS_REMOTE = 'remote';
const MEMBER_STATUS_ABSENT = 'absent';
const MEMBER_STATUS_ARRIVING = 'arriving';
const MEMBER_STATUS_IDLE = 'idle';
const MEMBER_STATUS_DEPARTING = 'departing';

const OVERLAY_STYLE_PLAIN = 'plain';
const OVERLAY_STYLE_ITALIC = 'italic';
const OVERLAY_STYLE_ASTERISKS = 'asterisks';
const OVERLAY_STYLE_BOLD = 'bold';
const OVERLAY_STYLE_BOLD_ITALIC = 'bold_italic';
const OVERLAY_STYLE_UNDERLINE = 'underline';
const OVERLAY_STYLE_STRIKE = 'strike';
const OVERLAY_STYLE_UPPERCASE = 'uppercase';
const OVERLAY_STYLE_LOWERCASE = 'lowercase';

const SEGMENT_DIALOGUE = 'dialogue';
const SEGMENT_ACTIONS = 'actions';
const SEGMENT_NARRATION = 'narration';
const SEGMENT_THOUGHTS = 'thoughts';
const SEGMENT_PARAMETERS = 'parameters';

const VOCALIA_EXTRA_KEY = 'aspectVocalia';
const VOCALIA_WITNESSES_KEY = 'witnesses';
const VOCALIA_GENERATE_INTERCEPTOR_NAME = 'aspectVocaliaGenerateInterceptor';

const DEBUG_LOG_MAX_ENTRIES = 2500;
const TRIGGER_ATTEMPT_HISTORY_MAX = 50;
const BLANK_MESSAGE_CORRELATION_MS = 30000;
const TRIGGER_MESSAGE_TIMEOUT_MS = 120000;

const REQUIRED_PARAMETER_KEYS = Object.freeze([
    'speakingto',
    'participationnextturn',
    'arriving',
]);

const OPTIONAL_PARAMETER_KEYS = Object.freeze([
    'remote',
]);

const KNOWN_PARAMETER_KEYS = Object.freeze([
    ...REQUIRED_PARAMETER_KEYS,
    ...OPTIONAL_PARAMETER_KEYS,
]);

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,

    autoSetManual: true,
    restoreOriginalStrategyOnDisable: true,

    // Code-only trigger methods. These stay in settings/persistence, but are
    // intentionally not exposed in the drawer UI.
    useSlashTrigger: true,
    fallbackToInternalGenerate: true,

    maxParticipantsPerTurn: 5,
    maxResponsesPerTurn: 5,
    maxResponsesPerParticipantPerTurn: 1,
    triggerDelayMs: 500,

    arrivalApplyMode: ARRIVAL_APPLY_IMMEDIATE,
    firstMessageFallback: FIRST_MESSAGE_FALLBACK_RANDOM_PRESENT,
    triggerNamedCharacterOnFirstUserMessage: true,

    occludeUnwitnessedHistory: true,

    renderOverlay: true,
    hideEmptySections: true,
    hideCharacterNameInRefinedMessage: true,
    hideThoughtsInRefinedMessage: true,
    quoteDialogue: true,

    actionDisplayStyle: OVERLAY_STYLE_ITALIC,
    narrationDisplayStyle: OVERLAY_STYLE_PLAIN,
    thoughtsDisplayStyle: OVERLAY_STYLE_ITALIC,

    promptDepth: 0,
    promptRole: EXTENSION_PROMPT_ROLE_SYSTEM,
    promptScan: false,
    strictPrompt: true,
    blockTagPrefix: 'character',

    hideDebugToasts: true,
});

const DEFAULT_CHAT_STATE = Object.freeze({
    version: 10,
    groupId: null,
    groupName: '',

    present: [],
    remote: [],
    absent: [],
    pendingArrivals: [],
    members: {},

    lastUserMessageId: null,
    lastParsedMessageId: null,
    assistantCountSinceUser: 0,
    chainCount: 0,
    activeTurnStartedAt: null,
    waitingForUserByAvatar: null,
    lastSpeakerAvatar: null,

    // Compatibility / diagnostics array.
    triggeredThisTurn: [],

    // Authoritative per-turn response tracking.
    participantResponseCountsThisTurn: {},

    originalActivationStrategies: {},
});

let initialized = false;
let queueRunning = false;
let triggerQueue = [];
let mutationObserver = null;
let styleElement = null;

let vocaliaDebugActive = false;
let vocaliaDebugStartedAt = null;
let vocaliaDebugStoppedAt = null;
let vocaliaDebugSequence = 0;
let vocaliaDebugEntries = [];

let vocaliaTriggerAttemptSequence = 0;
let vocaliaRecentTriggerAttempts = [];
let vocaliaPendingTriggerWaiters = [];

let vocaliaSendGuardInstalled = false;
let vocaliaEmptySendInProgress = false;
let vocaliaControlledGenerationInProgress = false;
let vocaliaBypassWarningLastShownAt = 0;

let vocaliaActiveGenerationTargetAvatar = null;
let vocaliaActiveGenerationTargetName = null;
let vocaliaActiveGenerationTargetStartedAt = null;
let vocaliaActiveGenerationTargetReason = null;

// ============================================================================
// Section 3. SillyTavern Context, Settings, and Persistence Helpers
// ============================================================================
// Purpose:
// - Centralize access to SillyTavern's context API.
// - Own extension settings and chatMetadata persistence.
// - Migrate legacy Group Speaker Router settings/state into Aspect: Vocalia.
// - Migrate renamed/inverted settings while keeping old internal call sites safe.
// - Migrate turn limits from old message/chain wording to true per-turn tracking.
// - Never infer a live turn reset from empty triggeredThisTurn/chainCount;
//   resets must happen only through explicit reset paths.
// ============================================================================

function ctx() {
    if (typeof importedGetContext === 'function') return importedGetContext();
    return SillyTavern.getContext();
}

function clone(value) {
    return typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function migrateExtensionBucket(container, defaultValue) {
    container[MODULE_NAME] ??= null;

    if (!container[MODULE_NAME]) {
        for (const legacyName of LEGACY_MODULE_NAMES) {
            if (container[legacyName]) {
                container[MODULE_NAME] = clone(container[legacyName]);
                break;
            }
        }
    }

    container[MODULE_NAME] ??= clone(defaultValue);
    return container[MODULE_NAME];
}

function isEnumerableOwnProperty(object, key) {
    return Object.prototype.propertyIsEnumerable.call(object, key);
}

function clampInteger(value, min, max, fallback) {
    const number = Number(value);
    const safe = Number.isFinite(number) ? Math.round(number) : fallback;
    return Math.min(max, Math.max(min, safe));
}

function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    const safe = Number.isFinite(number) ? number : fallback;
    return Math.min(max, Math.max(min, safe));
}

function migrateInvertedBooleanSetting(settings, legacyKey, newKey) {
    if (!Object.hasOwn(settings, newKey)) {
        if (isEnumerableOwnProperty(settings, legacyKey)) {
            settings[newKey] = !Boolean(settings[legacyKey]);
        } else {
            settings[newKey] = clone(DEFAULT_SETTINGS[newKey]);
        }
    }

    if (isEnumerableOwnProperty(settings, legacyKey)) {
        delete settings[legacyKey];
    }

    Object.defineProperty(settings, legacyKey, {
        configurable: true,
        enumerable: false,
        get() {
            return !Boolean(this[newKey]);
        },
        set(value) {
            this[newKey] = !Boolean(value);
        },
    });
}

function migrateNumericSetting(settings, legacyKey, newKey, min, max) {
    if (!Object.hasOwn(settings, newKey)) {
        if (isEnumerableOwnProperty(settings, legacyKey)) {
            settings[newKey] = settings[legacyKey];
        } else {
            settings[newKey] = clone(DEFAULT_SETTINGS[newKey]);
        }
    }

    settings[newKey] = clampInteger(settings[newKey], min, max, DEFAULT_SETTINGS[newKey]);

    if (isEnumerableOwnProperty(settings, legacyKey)) {
        delete settings[legacyKey];
    }

    Object.defineProperty(settings, legacyKey, {
        configurable: true,
        enumerable: false,
        get() {
            return this[newKey];
        },
        set(value) {
            this[newKey] = clampInteger(value, min, max, DEFAULT_SETTINGS[newKey]);
        },
    });
}

function migrateRenamedSettings(settings) {
    migrateInvertedBooleanSetting(settings, 'showCharacterLabels', 'hideCharacterNameInRefinedMessage');
    migrateInvertedBooleanSetting(settings, 'showThoughts', 'hideThoughtsInRefinedMessage');
    migrateInvertedBooleanSetting(settings, 'showDebugToasts', 'hideDebugToasts');

    migrateNumericSetting(settings, 'maxTriggersPerMessage', 'maxParticipantsPerTurn', 1, 10);
    migrateNumericSetting(settings, 'maxChainReplies', 'maxResponsesPerTurn', 0, 50);

    if (!Object.hasOwn(settings, 'maxResponsesPerParticipantPerTurn')) {
        settings.maxResponsesPerParticipantPerTurn = clone(DEFAULT_SETTINGS.maxResponsesPerParticipantPerTurn);
    }

    settings.maxParticipantsPerTurn = clampInteger(settings.maxParticipantsPerTurn, 1, 10, DEFAULT_SETTINGS.maxParticipantsPerTurn);
    settings.maxResponsesPerTurn = clampInteger(settings.maxResponsesPerTurn, 0, 50, DEFAULT_SETTINGS.maxResponsesPerTurn);
    settings.maxResponsesPerParticipantPerTurn = clampInteger(settings.maxResponsesPerParticipantPerTurn, 1, 3, DEFAULT_SETTINGS.maxResponsesPerParticipantPerTurn);
    settings.triggerDelayMs = Math.round(clampNumber(settings.triggerDelayMs, 0, 10000, DEFAULT_SETTINGS.triggerDelayMs));

    return settings;
}

function normalizeParticipantResponseCounts(value) {
    const source = (
        value
        && typeof value === 'object'
        && !Array.isArray(value)
    ) ? value : {};

    const cleanCounts = {};

    for (const [avatar, count] of Object.entries(source)) {
        const safeCount = clampInteger(count, 0, 100, 0);
        if (avatar && safeCount > 0) cleanCounts[avatar] = safeCount;
    }

    return cleanCounts;
}

function migrateTurnTrackingState(state) {
    state.triggeredThisTurn ??= [];
    state.participantResponseCountsThisTurn = normalizeParticipantResponseCounts(state.participantResponseCountsThisTurn);

    // Compatibility migration only:
    // if an older chat-state had triggeredThisTurn but no count map, convert it.
    // Do not use empty triggeredThisTurn + chainCount=0 as a reset signal.
    // Live resets are explicit and happen in resetTurnResponseTracking(),
    // handleUserMessage(), controlled generation setup, and empty-send setup.
    if (
        Object.keys(state.participantResponseCountsThisTurn).length === 0
        && Array.isArray(state.triggeredThisTurn)
        && state.triggeredThisTurn.length
    ) {
        const migratedCounts = {};

        for (const avatar of state.triggeredThisTurn) {
            if (avatar) migratedCounts[avatar] = 1;
        }

        state.participantResponseCountsThisTurn = normalizeParticipantResponseCounts(migratedCounts);
    }

    state.triggeredThisTurn = Object.keys(state.participantResponseCountsThisTurn);

    const totalFromCounts = Object.values(state.participantResponseCountsThisTurn)
        .reduce((sum, count) => sum + Number(count || 0), 0);

    if (totalFromCounts > Number(state.chainCount || 0)) {
        state.chainCount = totalFromCounts;
    }

    return state;
}

function getSettings() {
    const context = ctx();
    const settings = migrateExtensionBucket(context.extensionSettings, DEFAULT_SETTINGS);

    migrateRenamedSettings(settings);

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(settings, key)) settings[key] = clone(value);
    }

    migrateRenamedSettings(settings);

    return settings;
}

function getChatState() {
    const context = ctx();
    const state = migrateExtensionBucket(context.chatMetadata, DEFAULT_CHAT_STATE);

    for (const [key, value] of Object.entries(DEFAULT_CHAT_STATE)) {
        if (!Object.hasOwn(state, key)) state[key] = clone(value);
    }

    migrateTurnTrackingState(state);

    return state;
}

function saveSettings() {
    if (typeof importedSaveSettingsDebounced === 'function') {
        importedSaveSettingsDebounced();
        return;
    }

    ctx().saveSettingsDebounced?.();
}

async function saveMetadata() {
    const context = ctx();

    if (typeof context.saveMetadata === 'function') {
        await context.saveMetadata();
    } else if (typeof context.saveMetadataDebounced === 'function') {
        context.saveMetadataDebounced();
    }
}

// ============================================================================
// Section 4. General Utilities
// ============================================================================
// Purpose:
// - Provide reusable string, array, randomization, logging, timing helpers.
// - Provide structured debug logging that can be started/stopped from the drawer.
// - Correlate blank assistant messages with recent Vocalia trigger attempts.
// - Wait for actual assistant messages after /trigger returns.
// ============================================================================

function debug(...args) {
    console.debug(`[${MODULE_DISPLAY_NAME}]`, ...args);
}

function warn(...args) {
    console.warn(`[${MODULE_DISPLAY_NAME}]`, ...args);
}

function debugToast(message) {
    if (getSettings().showDebugToasts && globalThis.toastr) {
        toastr.info(String(message), MODULE_DISPLAY_NAME);
    }
}

function errorToast(message) {
    if (globalThis.toastr) toastr.error(String(message), MODULE_DISPLAY_NAME);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function escapeRegex(value) {
    return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function randomItem(items) {
    if (!Array.isArray(items) || !items.length) return null;
    return items[Math.floor(Math.random() * items.length)] ?? null;
}

function uniqueBy(items, keyGetter) {
    const seen = new Set();
    const result = [];

    for (const item of items) {
        const key = keyGetter(item);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(item);
    }

    return result;
}

function normalizeName(value) {
    return String(value ?? '')
        .trim()
        .replace(/^[@\s]+/, '')
        .replace(/[\s:;,.!?]+$/g, '')
        .toLocaleLowerCase();
}

function normalizeParameterKey(value) {
    return String(value ?? '')
        .trim()
        .replace(/[\s_-]+/g, '')
        .toLocaleLowerCase();
}

function isNoneValue(value) {
    return /^(?:none|null|n\/a|na|no one|nobody|empty|-)$/i.test(String(value ?? '').trim());
}

function isUserAlias(value) {
    return /^(?:user|you|me|player|human|{{user}}|<user>)$/i.test(String(value ?? '').trim());
}

function splitNameArray(value) {
    const text = String(value ?? '').trim();
    if (!text || isNoneValue(text)) return [];

    return text
        .split(/\s*(?:\||\/|&|\band\b)\s*/i)
        .map(part => part.trim())
        .filter(Boolean)
        .filter(part => !isNoneValue(part));
}

function normalizeParticipationStatus(value) {
    const status = String(value ?? 'idle').trim().toLocaleLowerCase();

    if (['speak', 'speaking', 'reply', 'respond', 'continue', 'continues'].includes(status)) return 'speak';
    if (['idle', 'listen', 'listening', 'silent', 'wait', 'waiting', 'none', 'stop'].includes(status)) return 'idle';
    if (['departing', 'depart', 'leaving', 'leave', 'leaves', 'exit', 'exits', 'absent'].includes(status)) return 'departing';

    return 'idle';
}

function isBlankText(value) {
    return !String(value ?? '').replace(/\u200B/g, '').trim();
}

function isBlankAssistantMessage(message) {
    return !!message && !message.is_user && !message.is_system && isBlankText(message.mes);
}

function getTriggerMessageTimeoutMs() {
    return TRIGGER_MESSAGE_TIMEOUT_MS;
}

function safeLogClone(value) {
    const seen = new WeakSet();

    try {
        return JSON.parse(JSON.stringify(value, (_key, val) => {
            if (typeof val === 'function') return `[Function ${val.name || 'anonymous'}]`;

            if (val instanceof Error) {
                return {
                    name: val.name,
                    message: val.message,
                    stack: val.stack,
                };
            }

            if (val instanceof HTMLElement) {
                return `[HTMLElement ${val.tagName.toLowerCase()}${val.id ? `#${val.id}` : ''}]`;
            }

            if (typeof val === 'object' && val !== null) {
                if (seen.has(val)) return '[Circular]';
                seen.add(val);
            }

            return val;
        }));
    } catch (error) {
        return {
            unserializable: true,
            message: String(error?.message ?? error),
            value: String(value),
        };
    }
}

function memberDebugSummary(member) {
    if (!member) return null;

    return {
        name: member.name,
        avatar: member.avatar,
        chid: member.chid,
        groupIndex: member.groupIndex,
        disabled: !!member.disabled,
    };
}

function avatarToDebugName(avatar) {
    try {
        const member = getMemberByAvatar(avatar, getGroupMembers());
        return member?.name ?? avatar;
    } catch {
        return avatar;
    }
}

function arrayDebugNames(avatars) {
    return [...new Set(avatars ?? [])].map(avatar => ({
        avatar,
        name: avatarToDebugName(avatar),
    }));
}

function getRosterDebugSnapshot() {
    let state;
    let members;

    try {
        state = getChatState();
        members = getGroupMembers();
    } catch (error) {
        return {
            error: String(error?.message ?? error),
        };
    }

    return {
        groupId: state.groupId,
        groupName: state.groupName,
        present: arrayDebugNames(state.present),
        remote: arrayDebugNames(state.remote),
        absent: arrayDebugNames(state.absent),
        pendingArrivals: arrayDebugNames(state.pendingArrivals),
        triggeredThisTurn: arrayDebugNames(state.triggeredThisTurn),
        waitingForUserByAvatar: state.waitingForUserByAvatar,
        waitingForUserName: state.waitingForUserByAvatar ? avatarToDebugName(state.waitingForUserByAvatar) : null,
        lastSpeakerAvatar: state.lastSpeakerAvatar,
        lastSpeakerName: state.lastSpeakerAvatar ? avatarToDebugName(state.lastSpeakerAvatar) : null,
        assistantCountSinceUser: state.assistantCountSinceUser,
        chainCount: state.chainCount,
        members: members.map(member => {
            const memberState = state.members?.[member.avatar] ?? {};
            return {
                ...memberDebugSummary(member),
                statePresence: memberState.presence,
                lastStatus: memberState.lastStatus,
                speakingTo: Array.isArray(memberState.speakingTo) ? [...memberState.speakingTo] : [],
                inPresent: (state.present ?? []).includes(member.avatar),
                inRemote: (state.remote ?? []).includes(member.avatar),
                inAbsent: (state.absent ?? []).includes(member.avatar),
                inPendingArrivals: (state.pendingArrivals ?? []).includes(member.avatar),
                triggeredThisTurn: (state.triggeredThisTurn ?? []).includes(member.avatar),
            };
        }),
    };
}

function getQueueDebugSnapshot() {
    return {
        queueRunning,
        length: triggerQueue.length,
        items: triggerQueue.map(item => ({
            sourceMessageId: item.sourceMessageId,
            reason: item.reason,
            enqueuedAt: item.enqueuedAt,
            member: memberDebugSummary(item.member),
        })),
    };
}

function getPendingTriggerWaiterDebugSnapshot() {
    return vocaliaPendingTriggerWaiters.map(waiter => ({
        id: waiter.id,
        attemptId: waiter.attemptId,
        memberName: waiter.memberName,
        memberAvatar: waiter.memberAvatar,
        startedAtIso: waiter.startedAtIso,
        timeoutMs: waiter.timeoutMs,
        sourceMessageId: waiter.sourceMessageId,
        reason: waiter.reason,
    }));
}

function getTriggerAttemptDebugSnapshot() {
    return vocaliaRecentTriggerAttempts.map(attempt => ({
        id: attempt.id,
        stage: attempt.stage,
        startedAtIso: attempt.startedAtIso,
        slashCommandReturnedAtIso: attempt.slashCommandReturnedAtIso ?? null,
        endedAtIso: attempt.endedAtIso ?? null,
        messageReceivedAtIso: attempt.messageReceivedAtIso ?? null,
        timedOutAtIso: attempt.timedOutAtIso ?? null,
        member: safeLogClone(attempt.member),
        sourceMessageId: attempt.sourceMessageId,
        reason: attempt.reason,
        queueReason: attempt.queueReason,
        chatLengthBefore: attempt.chatLengthBefore,
        chatLengthAfter: attempt.chatLengthAfter ?? null,
        messageId: attempt.messageId ?? null,
        messageBlank: attempt.messageBlank ?? null,
        completed: !!attempt.completed,
        failed: !!attempt.failed,
        timedOut: !!attempt.timedOut,
        error: attempt.error ?? null,
    }));
}

function getSettingsDebugSnapshot() {
    const settings = getSettings();

    return {
        enabled: settings.enabled,
        autoSetManual: settings.autoSetManual,
        restoreOriginalStrategyOnDisable: settings.restoreOriginalStrategyOnDisable,
        useSlashTrigger: settings.useSlashTrigger,
        fallbackToInternalGenerate: settings.fallbackToInternalGenerate,
        maxParticipantsPerTurn: settings.maxParticipantsPerTurn,
        maxResponsesPerTurn: settings.maxResponsesPerTurn,
        maxResponsesPerParticipantPerTurn: settings.maxResponsesPerParticipantPerTurn,
        triggerDelayMs: settings.triggerDelayMs,
        triggerMessageTimeoutMs: getTriggerMessageTimeoutMs(),
        arrivalApplyMode: settings.arrivalApplyMode,
        firstMessageFallback: settings.firstMessageFallback,
        triggerNamedCharacterOnFirstUserMessage: settings.triggerNamedCharacterOnFirstUserMessage,
        occludeUnwitnessedHistory: settings.occludeUnwitnessedHistory,
        renderOverlay: settings.renderOverlay,
        hideEmptySections: settings.hideEmptySections,
        hideCharacterNameInRefinedMessage: settings.hideCharacterNameInRefinedMessage,
        hideThoughtsInRefinedMessage: settings.hideThoughtsInRefinedMessage,
        quoteDialogue: settings.quoteDialogue,
        actionDisplayStyle: settings.actionDisplayStyle,
        narrationDisplayStyle: settings.narrationDisplayStyle,
        thoughtsDisplayStyle: settings.thoughtsDisplayStyle,
        promptDepth: settings.promptDepth,
        hideDebugToasts: settings.hideDebugToasts,
    };
}

function getMessageDebugSummary(messageId) {
    const message = ctx().chat?.[Number(messageId)];

    if (!message) {
        return {
            messageId,
            exists: false,
        };
    }

    const mes = String(message.mes ?? '');

    return {
        messageId: Number(messageId),
        exists: true,
        name: message.name,
        is_user: !!message.is_user,
        is_system: !!message.is_system,
        mesLength: mes.length,
        isBlank: isBlankText(mes),
        mesPreview: mes.slice(0, 1000),
    };
}

function recordTriggerAttemptStart(member, metadata = {}) {
    const attempt = {
        id: ++vocaliaTriggerAttemptSequence,
        stage: 'started',
        startedAtMs: Date.now(),
        startedAtIso: new Date().toISOString(),
        member: memberDebugSummary(member),
        memberName: member?.name ?? null,
        memberAvatar: member?.avatar ?? null,
        memberChid: Number(member?.chid),
        sourceMessageId: metadata.sourceMessageId ?? null,
        reason: metadata.reason ?? null,
        queueReason: metadata.queueReason ?? metadata.reason ?? null,
        chatLengthBefore: ctx().chat?.length ?? null,
        completed: false,
        failed: false,
        timedOut: false,
    };

    vocaliaRecentTriggerAttempts.push(attempt);

    if (vocaliaRecentTriggerAttempts.length > TRIGGER_ATTEMPT_HISTORY_MAX) {
        vocaliaRecentTriggerAttempts.splice(0, vocaliaRecentTriggerAttempts.length - TRIGGER_ATTEMPT_HISTORY_MAX);
    }

    logVocaliaEvent('trigger.attempt.recorded.start', {
        attempt: safeLogClone(attempt),
    });

    return attempt;
}

function recordTriggerAttemptCommandReturned(attempt) {
    if (!attempt) return null;

    attempt.stage = 'awaiting_message';
    attempt.slashCommandReturnedAtMs = Date.now();
    attempt.slashCommandReturnedAtIso = new Date().toISOString();
    attempt.chatLengthAfterSlashCommand = ctx().chat?.length ?? null;

    logVocaliaEvent('trigger.attempt.slash_command_returned', {
        attempt: safeLogClone(attempt),
        note: '/trigger returned; Vocalia is now waiting for the actual assistant message.',
    });

    return attempt;
}

function recordTriggerAttemptMessageReceived(attempt, messageId, message) {
    if (!attempt) return null;

    attempt.stage = 'message_received';
    attempt.messageReceivedAtMs = Date.now();
    attempt.messageReceivedAtIso = new Date().toISOString();
    attempt.endedAtMs = attempt.messageReceivedAtMs;
    attempt.endedAtIso = attempt.messageReceivedAtIso;
    attempt.chatLengthAfter = ctx().chat?.length ?? null;
    attempt.messageId = Number(messageId);
    attempt.messageName = message?.name ?? null;
    attempt.messageBlank = isBlankAssistantMessage(message);
    attempt.completed = true;
    attempt.failed = false;
    attempt.timedOut = false;

    logVocaliaEvent('trigger.attempt.message_received', {
        attempt: safeLogClone(attempt),
        message: getMessageDebugSummary(messageId),
    });

    return attempt;
}

function recordTriggerAttemptTimeout(attempt) {
    if (!attempt) return null;

    attempt.stage = 'timed_out';
    attempt.timedOutAtMs = Date.now();
    attempt.timedOutAtIso = new Date().toISOString();
    attempt.endedAtMs = attempt.timedOutAtMs;
    attempt.endedAtIso = attempt.timedOutAtIso;
    attempt.chatLengthAfter = ctx().chat?.length ?? null;
    attempt.completed = false;
    attempt.failed = false;
    attempt.timedOut = true;

    logVocaliaEvent('trigger.attempt.timeout', {
        attempt: safeLogClone(attempt),
        timeoutMs: getTriggerMessageTimeoutMs(),
    });

    return attempt;
}

function recordTriggerAttemptFailure(attempt, error) {
    if (!attempt) return null;

    attempt.stage = 'failed';
    attempt.endedAtMs = Date.now();
    attempt.endedAtIso = new Date().toISOString();
    attempt.chatLengthAfter = ctx().chat?.length ?? null;
    attempt.completed = false;
    attempt.failed = true;
    attempt.timedOut = false;
    attempt.error = error ? safeLogClone(error) : null;

    logVocaliaEvent('trigger.attempt.recorded.failed', {
        attempt: safeLogClone(attempt),
    });

    return attempt;
}

// Backward-compatible wrapper for older call sites.
function recordTriggerAttemptEnd(attempt, metadata = {}) {
    if (!attempt) return null;

    if (metadata.failed) return recordTriggerAttemptFailure(attempt, metadata.error);

    attempt.stage = 'completed';
    attempt.endedAtMs = Date.now();
    attempt.endedAtIso = new Date().toISOString();
    attempt.chatLengthAfter = ctx().chat?.length ?? null;
    attempt.completed = true;
    attempt.failed = false;
    attempt.timedOut = false;
    attempt.error = metadata.error ? safeLogClone(metadata.error) : null;

    logVocaliaEvent('trigger.attempt.recorded.end', {
        attempt: safeLogClone(attempt),
    });

    return attempt;
}

function hasPendingTriggerWaiters() {
    return vocaliaPendingTriggerWaiters.length > 0;
}

function resolveTriggeredWaiter(waiter, result) {
    if (!waiter) return;

    vocaliaPendingTriggerWaiters = vocaliaPendingTriggerWaiters.filter(item => item !== waiter);

    if (waiter.timer) {
        clearTimeout(waiter.timer);
        waiter.timer = null;
    }

    waiter.resolve(result);
}

function waitForTriggeredAssistantMessage(member, attempt, timeoutMs = getTriggerMessageTimeoutMs()) {
    if (!member || !attempt) {
        return Promise.resolve({
            status: 'no_wait',
            attempt,
            messageId: null,
            message: null,
        });
    }

    return new Promise(resolve => {
        const waiter = {
            id: `${attempt.id}:${member.avatar}:${Date.now()}`,
            attemptId: attempt.id,
            attempt,
            memberAvatar: member.avatar,
            memberName: member.name,
            sourceMessageId: attempt.sourceMessageId,
            reason: attempt.reason,
            startedAtMs: Date.now(),
            startedAtIso: new Date().toISOString(),
            timeoutMs,
            resolve,
            timer: null,
        };

        waiter.timer = setTimeout(() => {
            recordTriggerAttemptTimeout(attempt);
            resolveTriggeredWaiter(waiter, {
                status: 'timeout',
                attempt,
                messageId: null,
                message: null,
            });
        }, Math.max(1000, Number(timeoutMs) || TRIGGER_MESSAGE_TIMEOUT_MS));

        vocaliaPendingTriggerWaiters.push(waiter);

        logVocaliaEvent('trigger.waiter.started', {
            waiter: safeLogClone({
                id: waiter.id,
                attemptId: waiter.attemptId,
                memberAvatar: waiter.memberAvatar,
                memberName: waiter.memberName,
                timeoutMs: waiter.timeoutMs,
                sourceMessageId: waiter.sourceMessageId,
                reason: waiter.reason,
            }),
        });
    });
}

function resolvePendingTriggerWaitersForMessage(messageId, message) {
    if (!message || message.is_user || message.is_system) return [];

    const member = getMemberByName(message.name, getGroupMembers());
    if (!member) return [];

    const matching = vocaliaPendingTriggerWaiters.filter(waiter => waiter.memberAvatar === member.avatar);
    const resolved = [];

    for (const waiter of matching) {
        recordTriggerAttemptMessageReceived(waiter.attempt, messageId, message);

        const result = {
            status: isBlankAssistantMessage(message) ? 'blank_message_received' : 'message_received',
            attempt: waiter.attempt,
            messageId: Number(messageId),
            message,
        };

        resolved.push(result);
        resolveTriggeredWaiter(waiter, result);
    }

    if (resolved.length) {
        logVocaliaEvent('trigger.waiter.resolved_by_message', {
            messageId,
            message: getMessageDebugSummary(messageId),
            resolved: resolved.map(item => ({
                status: item.status,
                attemptId: item.attempt?.id ?? null,
                memberName: item.attempt?.memberName ?? null,
            })),
        });
    }

    return resolved;
}

function findRecentTriggerAttemptForMessage(message, messageId) {
    const now = Date.now();
    const messageName = normalizeName(message?.name ?? '');

    const candidates = vocaliaRecentTriggerAttempts
        .filter(attempt => {
            if (!attempt?.memberName) return false;
            if (now - Number(attempt.startedAtMs || 0) > BLANK_MESSAGE_CORRELATION_MS) return false;
            return normalizeName(attempt.memberName) === messageName;
        })
        .sort((a, b) => Number(b.startedAtMs || 0) - Number(a.startedAtMs || 0));

    const best = candidates[0] ?? null;

    return best ? {
        ...safeLogClone(best),
        correlatedMessageId: Number(messageId),
        ageMs: now - Number(best.startedAtMs || 0),
    } : null;
}

function logVocaliaEvent(type, details = {}, options = {}) {
    if (!vocaliaDebugActive && !options.force) return;

    const entry = {
        seq: ++vocaliaDebugSequence,
        at: new Date().toISOString(),
        type,
        details: safeLogClone(details),
        roster: getRosterDebugSnapshot(),
        queue: getQueueDebugSnapshot(),
        recentTriggerAttempts: getTriggerAttemptDebugSnapshot(),
        pendingTriggerWaiters: getPendingTriggerWaiterDebugSnapshot(),
    };

    vocaliaDebugEntries.push(entry);

    if (vocaliaDebugEntries.length > DEBUG_LOG_MAX_ENTRIES) {
        vocaliaDebugEntries.splice(0, vocaliaDebugEntries.length - DEBUG_LOG_MAX_ENTRIES);
    }

    console.debug(`[${MODULE_DISPLAY_NAME} Debug] ${type}`, entry);

    if (typeof updateDebugLogUi === 'function') {
        updateDebugLogUi();
    }
}

function startVocaliaDebugLog() {
    vocaliaDebugActive = true;
    vocaliaDebugStartedAt = new Date().toISOString();
    vocaliaDebugStoppedAt = null;
    vocaliaDebugSequence = 0;
    vocaliaDebugEntries = [];
    vocaliaRecentTriggerAttempts = [];
    vocaliaPendingTriggerWaiters = [];

    logVocaliaEvent('debug.start', {
        settings: getSettingsDebugSnapshot(),
        chatLength: ctx().chat?.length ?? null,
    }, { force: true });

    updateDebugLogUi?.();
}

function stopVocaliaDebugLog() {
    logVocaliaEvent('debug.stop', {
        settings: getSettingsDebugSnapshot(),
        chatLength: ctx().chat?.length ?? null,
    }, { force: true });

    vocaliaDebugActive = false;
    vocaliaDebugStoppedAt = new Date().toISOString();

    updateDebugLogUi?.();
}

function clearVocaliaDebugLog() {
    vocaliaDebugActive = false;
    vocaliaDebugStartedAt = null;
    vocaliaDebugStoppedAt = null;
    vocaliaDebugSequence = 0;
    vocaliaDebugEntries = [];
    vocaliaRecentTriggerAttempts = [];

    for (const waiter of vocaliaPendingTriggerWaiters) {
        if (waiter.timer) clearTimeout(waiter.timer);
    }

    vocaliaPendingTriggerWaiters = [];

    updateDebugLogUi?.();
}

function buildVocaliaDebugBundle() {
    return {
        extension: MODULE_DISPLAY_NAME,
        moduleName: MODULE_NAME,
        startedAt: vocaliaDebugStartedAt,
        stoppedAt: vocaliaDebugStoppedAt,
        active: vocaliaDebugActive,
        generatedAt: new Date().toISOString(),
        settings: getSettingsDebugSnapshot(),
        rosterAtExport: getRosterDebugSnapshot(),
        queueAtExport: getQueueDebugSnapshot(),
        recentTriggerAttemptsAtExport: getTriggerAttemptDebugSnapshot(),
        pendingTriggerWaitersAtExport: getPendingTriggerWaiterDebugSnapshot(),
        entries: safeLogClone(vocaliaDebugEntries),
    };
}

function getVocaliaDebugLogText() {
    return JSON.stringify(buildVocaliaDebugBundle(), null, 2);
}

async function copyVocaliaDebugLogToClipboard() {
    const text = getVocaliaDebugLogText();

    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();

    try {
        document.execCommand('copy');
        return true;
    } finally {
        textarea.remove();
    }
}

function downloadVocaliaDebugLog() {
    const text = getVocaliaDebugLogText();
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    anchor.href = url;
    anchor.download = `aspect-vocalia-debug-${timestamp}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    URL.revokeObjectURL(url);
}

// ============================================================================
// Section 5. Group and Member Resolution
// ============================================================================
// Purpose:
// - Resolve the current group and its members.
// - Match names safely while using avatars as stable state keys.
// - Enforce roster invariants:
//   1. No avatar may exist in more than one roster array.
//   2. pendingArrivals wins over present/remote/absent.
//   3. present wins over remote/absent.
//   4. remote wins over absent.
//   5. every active group member is represented exactly once.
// - Scrub stale routing references that point to absent/non-remote members.
// ============================================================================

function getCurrentGroup() {
    const context = ctx();
    if (!context.groupId) return null;
    return context.groups?.find(group => String(group.id) === String(context.groupId)) ?? null;
}

function getGroupMembers(group = getCurrentGroup()) {
    const context = ctx();
    if (!group || !Array.isArray(group.members)) return [];

    return group.members
        .map((avatar, groupIndex) => {
            const chid = context.characters.findIndex(character => character?.avatar === avatar || character?.name === avatar);
            if (chid < 0) return null;

            const character = context.characters[chid];
            return {
                chid,
                groupIndex,
                avatar,
                name: character?.name ?? String(avatar),
                disabled: Array.isArray(group.disabled_members) && group.disabled_members.includes(avatar),
                character,
            };
        })
        .filter(Boolean);
}

function getMemberByAvatar(avatar, members = getGroupMembers()) {
    return members.find(member => member.avatar === avatar) ?? null;
}

function getMemberByName(name, members = getGroupMembers()) {
    const normalized = normalizeName(name);
    if (!normalized || isUserAlias(normalized)) return null;

    let match = members.find(member => normalizeName(member.name) === normalized);
    if (match) return match;

    match = members.find(member => normalizeName(member.avatar) === normalized);
    if (match) return match;

    return members.find(member => {
        const memberName = normalizeName(member.name);
        return memberName && (memberName.includes(normalized) || normalized.includes(memberName));
    }) ?? null;
}

function uniqueMembers(members) {
    return uniqueBy(members.filter(Boolean), member => member.avatar);
}

function sanitizeAvatarArray(value, validAvatars) {
    const input = Array.isArray(value) ? value : [];
    const result = [];

    for (const avatar of input) {
        if (!avatar || !validAvatars.has(avatar)) continue;
        if (result.includes(avatar)) continue;
        result.push(avatar);
    }

    return result;
}

function normalizeRosterArrays(state, members) {
    const validAvatars = new Set(members.map(member => member.avatar));
    const disabledAvatars = new Set(members.filter(member => member.disabled).map(member => member.avatar));

    let pendingArrivals = sanitizeAvatarArray(state.pendingArrivals, validAvatars);
    let present = sanitizeAvatarArray(state.present, validAvatars);
    let remote = sanitizeAvatarArray(state.remote, validAvatars);
    let absent = sanitizeAvatarArray(state.absent, validAvatars);

    for (const avatar of disabledAvatars) {
        if (!absent.includes(avatar)) absent.push(avatar);
        pendingArrivals = pendingArrivals.filter(item => item !== avatar);
        present = present.filter(item => item !== avatar);
        remote = remote.filter(item => item !== avatar);
    }

    const pendingSet = new Set(pendingArrivals);
    present = present.filter(avatar => !pendingSet.has(avatar));
    remote = remote.filter(avatar => !pendingSet.has(avatar));
    absent = absent.filter(avatar => !pendingSet.has(avatar));

    const presentSet = new Set(present);
    remote = remote.filter(avatar => !presentSet.has(avatar));
    absent = absent.filter(avatar => !presentSet.has(avatar));

    const remoteSet = new Set(remote);
    absent = absent.filter(avatar => !remoteSet.has(avatar));

    for (const member of members) {
        if (member.disabled) continue;

        const avatar = member.avatar;
        if (pendingSet.has(avatar)) continue;
        if (presentSet.has(avatar)) continue;
        if (remoteSet.has(avatar)) continue;
        if (absent.includes(avatar)) continue;

        present.push(avatar);
    }

    state.pendingArrivals = [...new Set(pendingArrivals)];
    state.present = [...new Set(present)];
    state.remote = [...new Set(remote)];
    state.absent = [...new Set(absent)];

    const finalPending = new Set(state.pendingArrivals);
    state.present = state.present.filter(avatar => !finalPending.has(avatar));
    state.remote = state.remote.filter(avatar => !finalPending.has(avatar));
    state.absent = state.absent.filter(avatar => !finalPending.has(avatar));

    const finalPresent = new Set(state.present);
    state.remote = state.remote.filter(avatar => !finalPresent.has(avatar));
    state.absent = state.absent.filter(avatar => !finalPresent.has(avatar));

    const finalRemote = new Set(state.remote);
    state.absent = state.absent.filter(avatar => !finalRemote.has(avatar));

    return state;
}

function isAvatarPendingArrival(avatar, state = getChatState()) {
    return (state.pendingArrivals ?? []).includes(avatar);
}

function isAvatarActuallyPresent(avatar, state = getChatState()) {
    return (
        (state.present ?? []).includes(avatar)
        && !(state.remote ?? []).includes(avatar)
        && !(state.absent ?? []).includes(avatar)
        && !(state.pendingArrivals ?? []).includes(avatar)
    );
}

function isAvatarRemote(avatar, state = getChatState()) {
    return (
        (state.remote ?? []).includes(avatar)
        && !(state.present ?? []).includes(avatar)
        && !(state.absent ?? []).includes(avatar)
        && !(state.pendingArrivals ?? []).includes(avatar)
    );
}

function isAvatarRouteEligible(avatar, state = getChatState()) {
    return isAvatarActuallyPresent(avatar, state) || isAvatarRemote(avatar, state);
}

function isAvatarAbsent(avatar, state = getChatState()) {
    return (
        (state.absent ?? []).includes(avatar)
        && !isAvatarActuallyPresent(avatar, state)
        && !isAvatarRemote(avatar, state)
        && !isAvatarPendingArrival(avatar, state)
    );
}

function updateMemberPresenceFlags(state, members) {
    for (const member of members) {
        const memberState = state.members[member.avatar];
        if (!memberState) continue;

        if (isAvatarPendingArrival(member.avatar, state)) {
            memberState.presence = MEMBER_STATUS_ARRIVING;
        } else if (isAvatarActuallyPresent(member.avatar, state)) {
            memberState.presence = MEMBER_STATUS_PRESENT;
        } else if (isAvatarRemote(member.avatar, state)) {
            memberState.presence = MEMBER_STATUS_REMOTE;
        } else {
            memberState.presence = MEMBER_STATUS_ABSENT;
        }
    }
}

function scrubStaleRoutingReferences(state, members) {
    const validAvatars = new Set(members.map(member => member.avatar));
    const routeEligibleAvatars = new Set(
        members
            .filter(member => validAvatars.has(member.avatar))
            .filter(member => !member.disabled)
            .filter(member => isAvatarRouteEligible(member.avatar, state))
            .map(member => member.avatar),
    );

    if (state.waitingForUserByAvatar && !routeEligibleAvatars.has(state.waitingForUserByAvatar)) {
        state.waitingForUserByAvatar = null;
    }

    if (state.lastSpeakerAvatar && !routeEligibleAvatars.has(state.lastSpeakerAvatar)) {
        state.lastSpeakerAvatar = null;
    }

    state.triggeredThisTurn = (state.triggeredThisTurn ?? [])
        .filter(avatar => validAvatars.has(avatar))
        .filter(avatar => routeEligibleAvatars.has(avatar));

    for (const [avatar, memberState] of Object.entries(state.members ?? {})) {
        if (!validAvatars.has(avatar)) continue;

        if (!isAvatarRouteEligible(avatar, state)) {
            if (Array.isArray(memberState.speakingTo)) {
                memberState.speakingTo = memberState.speakingTo.filter(name => {
                    const member = getMemberByName(name, members);
                    return member && isAvatarRouteEligible(member.avatar, state);
                });
            }

            if (memberState.lastStatus === MEMBER_STATUS_DEPARTING) {
                memberState.lastStatus = MEMBER_STATUS_IDLE;
            }
        }
    }
}

function ensureStateForCurrentGroup() {
    const group = getCurrentGroup();
    const state = getChatState();

    if (!group) {
        state.groupId = null;
        state.groupName = '';
        state.present = [];
        state.remote = [];
        state.absent = [];
        state.pendingArrivals = [];
        state.members = {};
        state.waitingForUserByAvatar = null;
        state.lastSpeakerAvatar = null;
        state.triggeredThisTurn = [];
        return state;
    }

    const members = getGroupMembers(group);
    const avatars = new Set(members.map(member => member.avatar));
    const groupChanged = String(state.groupId ?? '') !== String(group.id);

    state.groupId = group.id;
    state.groupName = group.name ?? '';
    state.members ??= {};
    state.present ??= [];
    state.remote ??= [];
    state.absent ??= [];
    state.pendingArrivals ??= [];
    state.originalActivationStrategies ??= {};
    state.triggeredThisTurn ??= [];

    for (const member of members) {
        state.members[member.avatar] ??= {
            avatar: member.avatar,
            name: member.name,
            chid: member.chid,
            groupIndex: member.groupIndex,
            presence: MEMBER_STATUS_PRESENT,
            lastStatus: MEMBER_STATUS_IDLE,
            speakingTo: [],
            lastSeenMessageId: null,
        };

        Object.assign(state.members[member.avatar], {
            avatar: member.avatar,
            name: member.name,
            chid: member.chid,
            groupIndex: member.groupIndex,
            disabled: !!member.disabled,
        });
    }

    for (const avatar of Object.keys(state.members)) {
        if (!avatars.has(avatar)) delete state.members[avatar];
    }

    state.triggeredThisTurn = sanitizeAvatarArray(state.triggeredThisTurn, avatars);

    if (groupChanged || (!state.present.length && !state.remote.length && !state.absent.length && !state.pendingArrivals.length)) {
        state.present = members.filter(member => !member.disabled).map(member => member.avatar);
        state.remote = [];
        state.absent = members.filter(member => member.disabled).map(member => member.avatar);
        state.pendingArrivals = [];

        state.lastUserMessageId = null;
        state.lastParsedMessageId = null;
        state.assistantCountSinceUser = 0;
        state.chainCount = 0;
        state.activeTurnStartedAt = null;
        state.waitingForUserByAvatar = null;
        state.lastSpeakerAvatar = null;
        state.triggeredThisTurn = [];
    }

    normalizeRosterArrays(state, members);
    updateMemberPresenceFlags(state, members);
    scrubStaleRoutingReferences(state, members);

    return state;
}

function getPresentMembers() {
    const state = ensureStateForCurrentGroup();
    const members = getGroupMembers();

    return members
        .filter(member => !member.disabled)
        .filter(member => isAvatarActuallyPresent(member.avatar, state));
}

function getRemoteMembers() {
    const state = ensureStateForCurrentGroup();
    const members = getGroupMembers();

    return members
        .filter(member => !member.disabled)
        .filter(member => isAvatarRemote(member.avatar, state));
}

function getRouteEligibleMembers() {
    const state = ensureStateForCurrentGroup();
    const members = getGroupMembers();

    return members
        .filter(member => !member.disabled)
        .filter(member => isAvatarRouteEligible(member.avatar, state));
}

function getAbsentMembers() {
    const state = ensureStateForCurrentGroup();
    const members = getGroupMembers();

    return members
        .filter(member => isAvatarAbsent(member.avatar, state));
}

function setPresence(avatar, presence) {
    const state = getChatState();
    const members = getGroupMembers();
    const member = getMemberByAvatar(avatar, members);

    if (!avatar || !member || !state.members?.[avatar]) return;

    state.present = (state.present ?? []).filter(item => item !== avatar);
    state.remote = (state.remote ?? []).filter(item => item !== avatar);
    state.absent = (state.absent ?? []).filter(item => item !== avatar);
    state.pendingArrivals = (state.pendingArrivals ?? []).filter(item => item !== avatar);

    if (member.disabled) {
        state.absent.push(avatar);
        state.members[avatar].presence = MEMBER_STATUS_ABSENT;
    } else if (presence === MEMBER_STATUS_ARRIVING || presence === 'arriving') {
        state.pendingArrivals.push(avatar);
        state.members[avatar].presence = MEMBER_STATUS_ARRIVING;
    } else if (presence === MEMBER_STATUS_REMOTE || presence === 'remote') {
        state.remote.push(avatar);
        state.members[avatar].presence = MEMBER_STATUS_REMOTE;
    } else if (presence === 'absent' || presence === MEMBER_STATUS_ABSENT) {
        state.absent.push(avatar);
        state.members[avatar].presence = MEMBER_STATUS_ABSENT;
    } else {
        state.present.push(avatar);
        state.members[avatar].presence = MEMBER_STATUS_PRESENT;
    }

    normalizeRosterArrays(state, members);
    updateMemberPresenceFlags(state, members);
    scrubStaleRoutingReferences(state, members);
}

function getNamePartsForAliasMatching(name) {
    return String(name ?? '')
        .trim()
        .split(/\s+/g)
        .map(part => part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
        .filter(Boolean);
}

function buildMentionAliasEntries(members) {
    const entries = [];
    const firstNameOwners = new Map();

    for (const member of members) {
        const first = normalizeName(getNamePartsForAliasMatching(member.name)[0] ?? '');
        if (!first) continue;
        if (!firstNameOwners.has(first)) firstNameOwners.set(first, []);
        firstNameOwners.get(first).push(member);
    }

    for (const member of members) {
        const aliases = new Set();
        const fullName = String(member.name ?? '').trim();
        const first = getNamePartsForAliasMatching(fullName)[0] ?? '';

        if (fullName) aliases.add(fullName);
        if (first && (firstNameOwners.get(normalizeName(first)) ?? []).length === 1) aliases.add(first);

        for (const alias of aliases) {
            const clean = String(alias ?? '').trim();
            if (!clean || clean.length < 2 || isUserAlias(clean)) continue;
            entries.push({ member, alias: clean, aliasLength: clean.length });
        }
    }

    entries.sort((a, b) => b.aliasLength - a.aliasLength);
    return entries;
}

function containsNameMention(source, alias) {
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])@?${escapeRegex(alias)}([^\\p{L}\\p{N}_]|$)`, 'iu');
    return pattern.test(String(source ?? ''));
}

function findMentionedPresentMembers(text) {
    const entries = buildMentionAliasEntries(getRouteEligibleMembers());
    const matches = [];

    for (const entry of entries) {
        if (containsNameMention(text, entry.alias)) matches.push(entry.member);
    }

    return uniqueMembers(matches);
}

function resolveNamesToMembers(names) {
    const members = getGroupMembers();
    return uniqueMembers(
        names
            .filter(name => !isUserAlias(name))
            .map(name => getMemberByName(name, members))
            .filter(Boolean),
    );
}

// ============================================================================
// Section 6. User-Turn Selection Core Helpers
// ============================================================================
// Purpose:
// - Resolve message IDs and user message text.
// - Resolve route-eligible, absent, and departure candidate members.
// - Provide shared regex/category helpers used by user-side transition classifiers.
// - Keep trigger target limiting tied to Max Participants Per Turn.
// ============================================================================

function getAssistantMessagesBefore(messageId) {
    const context = ctx();
    const limit = Number.isInteger(Number(messageId)) ? Number(messageId) : context.chat.length;

    return context.chat
        .slice(0, Math.max(0, limit))
        .map((message, index) => ({ message, messageId: index }))
        .filter(item => item.message && !item.message.is_user && !item.message.is_system);
}

function resolveMessageId(eventValue) {
    const context = ctx();

    if (Number.isInteger(Number(eventValue))) return Number(eventValue);
    if (eventValue && Number.isInteger(Number(eventValue.messageId))) return Number(eventValue.messageId);
    if (eventValue && Number.isInteger(Number(eventValue.id))) return Number(eventValue.id);

    return Math.max(0, context.chat.length - 1);
}

function getMessageText(messageId) {
    return String(ctx().chat?.[messageId]?.mes ?? '');
}

function getMaxTriggerTargets() {
    return Math.max(1, Number(getSettings().maxParticipantsPerTurn) || 1);
}

function limitTriggerTargets(members) {
    return uniqueMembers(members).slice(0, getMaxTriggerTargets());
}

function getRouteEligibleMembersCompat() {
    if (typeof getRouteEligibleMembers === 'function') return getRouteEligibleMembers();
    return getPresentMembers();
}

function isMemberRouteEligibleCompat(member) {
    if (!member || member.disabled) return false;

    const state = ensureStateForCurrentGroup();

    if (typeof isAvatarRouteEligible === 'function') return isAvatarRouteEligible(member.avatar, state);
    if (typeof isAvatarActuallyPresent === 'function') return isAvatarActuallyPresent(member.avatar, state);

    return (
        (state.present ?? []).includes(member.avatar)
        && !(state.absent ?? []).includes(member.avatar)
        && !(state.pendingArrivals ?? []).includes(member.avatar)
    );
}

function getAbsentSummonCandidates() {
    return getGroupMembers()
        .filter(member => !member.disabled)
        .filter(member => {
            const state = ensureStateForCurrentGroup();

            if (typeof isAvatarRouteEligible === 'function' && isAvatarRouteEligible(member.avatar, state)) return false;
            if (typeof isAvatarActuallyPresent === 'function' && isAvatarActuallyPresent(member.avatar, state)) return false;

            return (state.absent ?? []).includes(member.avatar) || !(state.present ?? []).includes(member.avatar);
        });
}

function getPresentDepartureCandidates() {
    const state = ensureStateForCurrentGroup();

    if (typeof getPresentMembers === 'function') {
        return getPresentMembers().filter(member => !member.disabled);
    }

    return getGroupMembers()
        .filter(member => !member.disabled)
        .filter(member => {
            if (typeof isAvatarActuallyPresent === 'function') {
                return isAvatarActuallyPresent(member.avatar, state);
            }

            return (
                (state.present ?? []).includes(member.avatar)
                && !(state.remote ?? []).includes(member.avatar)
                && !(state.absent ?? []).includes(member.avatar)
                && !(state.pendingArrivals ?? []).includes(member.avatar)
            );
        });
}

function buildSummonAliasEntries(members) {
    return buildMentionAliasEntries(members);
}

function matchesAnyPattern(text, patterns) {
    return patterns.some(pattern => pattern.test(text));
}

function wordsAlternation(words) {
    return words
        .map(word => escapeRegex(word))
        .sort((a, b) => b.length - a.length)
        .join('|');
}

function getUserSceneAliases() {
    const aliases = new Set([
        'i',
        'me',
        'myself',
        'my character',
        '{{user}}',
        '<user>',
    ]);

    const context = ctx?.();

    for (const value of [
        context?.name1,
        context?.userAlias,
        context?.personaName,
        globalThis.name1,
        globalThis.userName,
    ]) {
        const text = String(value ?? '').trim();
        if (text && !isUserAlias(text)) aliases.add(text);
    }

    return [...aliases]
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);
}

function getUserSubjectPattern() {
    return `(?:${wordsAlternation(getUserSceneAliases())})`;
}

// ============================================================================
// Section 7. User-Side Summon and Departure Detection
// ============================================================================
// Purpose:
// - Detect user-side remote contact or physical summons for absent members.
// - Detect high-confidence user-side departure / leave-behind transitions.
// - Keep presence persistent by default unless departure is explicitly proven.
// - Apply user-side scene-state transitions before routing targets are selected.
// ============================================================================

function isRemoteContactForAlias(text, alias) {
    const escapedAlias = escapeRegex(alias);

    const remoteChannel = '(?:phone|text|dm|message|radio|video\\s*call|facetime|intercom|walkie(?:-talkie)?|contact|call)';
    const contactVerb = '(?:phone|text|dm|message|radio|video\\s*call|facetime|contact|call|reach|get|hail|signal)';

    const patterns = [
        new RegExp(`\\b${contactVerb}\\s+(?:for\\s+)?${escapedAlias}\\b`, 'iu'),
        new RegExp(`\\b${contactVerb}\\s+${escapedAlias}\\s+(?:on|by|via|through)\\s+(?:the\\s+)?${remoteChannel}\\b`, 'iu'),
        new RegExp(`\\b${escapedAlias}\\s+(?:on|by|via|through)\\s+(?:the\\s+)?${remoteChannel}\\b`, 'iu'),
    ];

    return matchesAnyPattern(text, patterns);
}

function isPhysicalSummonForAlias(text, alias) {
    const escapedAlias = escapeRegex(alias);

    const summonVerb = '(?:call|shout|yell|cry\\s*out|holler|summon|bring|fetch|request|ask|get|wave|motion|gesture)';
    const joinImperative = '(?:come\\s+here|come\\s+over|get\\s+over\\s+here|join\\s+(?:me|us)|show\\s+up|step\\s+in|come\\s+in)';
    const physicalNoticeVerb = '(?:spot|see|notice|find|locate|encounter|run\\s+into)';
    const arrivalVerb = '(?:arrives|enters|walks\\s+in|steps\\s+in|joins|appears|comes\\s+over|comes\\s+here|shows\\s+up)';

    const patterns = [
        new RegExp(`\\b${summonVerb}\\s+(?:for\\s+)?${escapedAlias}\\b`, 'iu'),
        new RegExp(`\\b${escapedAlias}\\s*,?\\s*${joinImperative}\\b`, 'iu'),
        new RegExp(`\\b${joinImperative}\\s*,?\\s*${escapedAlias}\\b`, 'iu'),
        new RegExp(`\\b${physicalNoticeVerb}\\s+${escapedAlias}\\b`, 'iu'),
        new RegExp(`\\b${escapedAlias}\\s+${arrivalVerb}\\b`, 'iu'),
        new RegExp(`(^|[\\s"'“‘])${escapedAlias}[!！](?:\\s|$)`, 'iu'),
    ];

    return matchesAnyPattern(text, patterns);
}

function isExplicitLeaveBehindForAlias(text, alias) {
    const escapedAlias = escapeRegex(alias);

    const leaveBehindVerb = '(?:leave|leaving|left|keep|kept)';
    const stationaryVerb = '(?:stay|stays|wait|waits|remain|remains|hold\\s+position|keep\\s+watch|guard|watch)';
    const placeAdverb = '(?:behind|here|there|at\\s+(?:this|that|the)\\s+place|where\\s+(?:you|they|he|she)\\s+(?:are|were))';

    const patterns = [
        new RegExp(`\\b${leaveBehindVerb}\\s+${escapedAlias}\\s+${placeAdverb}\\b`, 'iu'),
        new RegExp(`\\b${escapedAlias}\\s+(?:is\\s+|was\\s+|gets\\s+|got\\s+)?(?:left|kept)\\s+${placeAdverb}\\b`, 'iu'),
        new RegExp(`\\b${escapedAlias}\\s*,?\\s*${stationaryVerb}\\s+${placeAdverb}\\b`, 'iu'),
        new RegExp(`\\b${stationaryVerb}\\s+${placeAdverb}\\s*,?\\s*${escapedAlias}\\b`, 'iu'),
        new RegExp(`\\b(?:tell|ask|order|instruct)\\s+${escapedAlias}\\s+to\\s+${stationaryVerb}\\s+${placeAdverb}\\b`, 'iu'),
    ];

    return matchesAnyPattern(text, patterns);
}

function secondPersonWaitsBehind(text) {
    const stationaryVerb = '(?:wait|stay|remain|hold\\s+position|keep\\s+watch|guard|watch)';
    const placeAdverb = '(?:here|there|behind|at\\s+(?:this|that|the)\\s+place)';

    const patterns = [
        new RegExp(`\\b(?:you|you all|both of you|all of you)\\s+${stationaryVerb}\\s+${placeAdverb}\\b`, 'iu'),
        new RegExp(`\\b${stationaryVerb}\\s+${placeAdverb}\\b`, 'iu'),
    ];

    return matchesAnyPattern(text, patterns);
}

function isGroupInclusiveMovement(text) {
    const groupSubject = '(?:we|we\\s+all|all\\s+of\\s+us|the\\s+group|everyone|everybody|the\\s+others|you\\s+all|both\\s+of\\s+you|all\\s+of\\s+you)';
    const movementVerb = buildMovementVerbPattern();
    const togetherness = '(?:together|as\\s+a\\s+group|with\\s+me|with\\s+us|alongside|behind\\s+me|after\\s+me|following\\s+me|coming\\s+with)';

    const patterns = [
        new RegExp(`\\b${groupSubject}\\s+(?:${movementVerb})\\b`, 'iu'),
        new RegExp(`\\b${groupSubject}\\b[\\s\\S]{0,120}\\b${togetherness}\\b`, 'iu'),
        new RegExp(`\\b${togetherness}\\b`, 'iu'),
    ];

    return matchesAnyPattern(text, patterns);
}

function buildMovementVerbPattern() {
    // Semantic category: singular-user movement, relocation, searching, or scene-exit action.
    // This is not a one-off phrase list; these are the action families that imply the
    // user's active scene may be changing.
    const movementVerbs = [
        'go',
        'head',
        'move',
        'walk',
        'run',
        'jog',
        'dash',
        'rush',
        'step',
        'slip',
        'sneak',
        'creep',
        'wander',
        'roam',
        'stroll',
        'travel',
        'proceed',
        'continue',
        'search',
        'look',
        'scout',
        'explore',
        'enter',
        'exit',
        'leave',
        'depart',
        'cross',
        'pass',
        'round',
        'turn',
        'circle',
        'cut',
        'thread',
        'push',
        'disappear',
        'vanish',
    ];

    return wordsAlternation(movementVerbs);
}

function buildSceneTransitionMarkerPattern() {
    // Semantic category: markers that the user is moving into/through/across/out of
    // a distinct active-space relation, rather than merely adjusting posture in place.
    const markers = [
        'to',
        'toward',
        'towards',
        'into',
        'inside',
        'through',
        'across',
        'past',
        'beyond',
        'around',
        'about',
        'along',
        'down',
        'up',
        'out',
        'outside',
        'away',
        'off',
        'from',
        'deeper',
        'further',
        'ahead',
        'back',
        'forward',
    ];

    return wordsAlternation(markers);
}

function userHasSingularMovementClause(text) {
    const source = String(text ?? '');
    const userSubject = getUserSubjectPattern();
    const movementVerb = buildMovementVerbPattern();
    const transitionMarker = buildSceneTransitionMarkerPattern();

    const patterns = [
        // "I walk into...", "Neo heads through...", "I turn and walk away..."
        new RegExp(`\\b${userSubject}\\b[\\s\\S]{0,180}\\b(?:${movementVerb})\\b[\\s\\S]{0,140}\\b(?:${transitionMarker})\\b`, 'iu'),

        // Continued same-subject movement after an initial first-person clause:
        // "I turn around, then move into..."
        new RegExp(`\\b${userSubject}\\b[\\s\\S]{0,80}\\b(?:then|and|before|after|as)\\b[\\s\\S]{0,120}\\b(?:${movementVerb})\\b[\\s\\S]{0,140}\\b(?:${transitionMarker})\\b`, 'iu'),

        // Strong scene-exit verbs need less spatial marking.
        new RegExp(`\\b${userSubject}\\b[\\s\\S]{0,120}\\b(?:leave|depart|exit|disappear|vanish)\\b`, 'iu'),

        // "off I go", "away I walk", etc.
        new RegExp(`\\b(?:away|off|ahead|forward)\\b[\\s\\S]{0,80}\\b${userSubject}\\b[\\s\\S]{0,80}\\b(?:${movementVerb})\\b`, 'iu'),
    ];

    return matchesAnyPattern(source, patterns);
}

function hasNamedProximityOrAccompaniment(text, alias) {
    const escapedAlias = escapeRegex(alias);
    const userSubject = getUserSubjectPattern();

    const accompanyVerb = '(?:follow|follows|followed|come|comes|came|go|goes|went|head|heads|headed|walk|walks|walked|run|runs|ran|move|moves|moved|join|joins|joined|accompany|accompanies|accompanied|trail|trails|trailed)';
    const takingVerb = '(?:take|bring|lead|guide|pull|drag|motion|gesture|wave|beckon)';
    const proximity = '(?:with|beside|alongside|near|next\\s+to|close\\s+to|behind|after|following)';

    const patterns = [
        new RegExp(`\\b${escapedAlias}\\s+(?:${accompanyVerb})\\b[\\s\\S]{0,80}\\b(?:me|us|${userSubject}|along|behind|after)\\b`, 'iu'),
        new RegExp(`\\b${userSubject}\\b[\\s\\S]{0,80}\\b(?:${takingVerb})\\s+${escapedAlias}\\b[\\s\\S]{0,80}\\b(?:with\\s+me|with\\s+us|along|behind|after)?\\b`, 'iu'),
        new RegExp(`\\b${proximity}\\s+${escapedAlias}\\b`, 'iu'),
        new RegExp(`\\b${escapedAlias}\\s+(?:is|was|stays|remains|keeps)\\s+${proximity}\\s+(?:me|${userSubject})\\b`, 'iu'),
        new RegExp(`\\b${escapedAlias}\\s+and\\s+${userSubject}\\b`, 'iu'),
        new RegExp(`\\b${userSubject}\\s+and\\s+${escapedAlias}\\b`, 'iu'),
    ];

    return matchesAnyPattern(text, patterns);
}

function getMembersAccompanyingUser(text, candidates) {
    const source = String(text ?? '');

    if (isGroupInclusiveMovement(source)) {
        return uniqueMembers(candidates);
    }

    const accompanying = [];
    const aliasEntries = buildMentionAliasEntries(candidates);

    for (const entry of aliasEntries) {
        if (hasNamedProximityOrAccompaniment(source, entry.alias)) {
            accompanying.push(entry.member);
        }
    }

    return uniqueMembers(accompanying);
}

function userExplicitlyMovesAloneAwayFromPresentMembers(text) {
    const source = String(text ?? '');
    const userSubject = getUserSubjectPattern();
    const movementVerb = buildMovementVerbPattern();
    const transitionMarker = buildSceneTransitionMarkerPattern();

    const soloMarker = '(?:alone|by\\s+myself|on\\s+my\\s+own|by\\s+my\\s+lonesome|without\\s+(?:them|anyone|the\\s+others|everyone|everybody|you|you\\s+all|both\\s+of\\s+you|all\\s+of\\s+you))';
    const leaveBehindObject = '(?:them|the\\s+others|everyone|everybody|you|you\\s+all|both\\s+of\\s+you|all\\s+of\\s+you)';
    const leaveBehindPlace = '(?:behind|here|there|at\\s+(?:this|that|the)\\s+place|where\\s+(?:they|you)\\s+(?:are|were))';

    const patterns = [
        new RegExp(`\\b${userSubject}\\b[\\s\\S]{0,160}\\b(?:${movementVerb})\\b[\\s\\S]{0,120}\\b(?:${transitionMarker})\\b[\\s\\S]{0,80}\\b${soloMarker}\\b`, 'iu'),
        new RegExp(`\\b${userSubject}\\b[\\s\\S]{0,120}\\b${soloMarker}\\b[\\s\\S]{0,160}\\b(?:${movementVerb})\\b`, 'iu'),
        new RegExp(`\\b${userSubject}\\b[\\s\\S]{0,180}\\b(?:leave|leaving|left)\\s+${leaveBehindObject}\\s+${leaveBehindPlace}\\b`, 'iu'),
        new RegExp(`\\b${userSubject}\\b[\\s\\S]{0,180}\\b(?:${movementVerb})\\b[\\s\\S]{0,160}\\b(?:leaving|left)\\s+${leaveBehindObject}\\s+${leaveBehindPlace}\\b`, 'iu'),
    ];

    return matchesAnyPattern(source, patterns);
}

function userClearlyLeavesCurrentPlaceAlone(text, candidates = getPresentDepartureCandidates()) {
    const source = String(text ?? '');

    // Presence persists by default. A generic movement clause such as
    // "I run forward", "I round the corner", or "I charge her" is not enough
    // to remove present characters from the active scene. This helper only
    // returns true when the user explicitly marks movement as alone, without
    // the others, or leaving them behind.
    if (!candidates.length) return false;
    if (!userHasSingularMovementClause(source)) return false;
    if (isGroupInclusiveMovement(source)) return false;
    if (!userExplicitlyMovesAloneAwayFromPresentMembers(source)) return false;

    const accompanying = getMembersAccompanyingUser(source, candidates);
    return accompanying.length < candidates.length;
}

function detectUserDepartureBootstrap(text) {
    const source = String(text ?? '');
    const candidates = getPresentDepartureCandidates();
    const departed = [];
    const evidence = [];

    const aliasEntries = buildMentionAliasEntries(candidates);

    // Presence persists unless there is positive leave-behind evidence.
    // Do not try to prove that present characters are still with the user;
    // instead, prove that they became absent.
    for (const entry of aliasEntries) {
        if (isExplicitLeaveBehindForAlias(source, entry.alias)) {
            departed.push(entry.member);
            evidence.push({
                type: MEMBER_STATUS_DEPARTING,
                member: memberDebugSummary(entry.member),
                alias: entry.alias,
                reason: 'explicit_named_leave_behind',
            });
        }
    }

    if (userHasSingularMovementClause(source) && secondPersonWaitsBehind(source)) {
        if (candidates.length === 1) {
            departed.push(candidates[0]);
            evidence.push({
                type: MEMBER_STATUS_DEPARTING,
                member: memberDebugSummary(candidates[0]),
                alias: 'implicit-you',
                reason: 'single_present_character_left_behind_by_user',
            });
        } else if (/\b(?:you all|both of you|all of you)\b/iu.test(source)) {
            for (const member of candidates) {
                departed.push(member);
                evidence.push({
                    type: MEMBER_STATUS_DEPARTING,
                    member: memberDebugSummary(member),
                    alias: 'plural-you',
                    reason: 'all_present_characters_left_behind_by_user',
                });
            }
        }
    }

    if (userClearlyLeavesCurrentPlaceAlone(source, candidates) && candidates.length) {
        const accompanying = getMembersAccompanyingUser(source, candidates);
        const accompanyingAvatars = new Set(accompanying.map(member => member.avatar));

        for (const member of candidates) {
            if (accompanyingAvatars.has(member.avatar)) {
                evidence.push({
                    type: MEMBER_STATUS_PRESENT,
                    member: memberDebugSummary(member),
                    alias: member.name,
                    reason: 'member_accompanies_or_remains_near_user_not_departed',
                });
                continue;
            }

            departed.push(member);
            evidence.push({
                type: MEMBER_STATUS_DEPARTING,
                member: memberDebugSummary(member),
                alias: member.name,
                reason: 'explicit_user_left_active_scene_alone_member_left_behind',
            });
        }
    }

    if (!departed.length) {
        evidence.push({
            type: MEMBER_STATUS_PRESENT,
            reason: userHasSingularMovementClause(source)
                ? 'presence_persists_generic_user_movement_not_departure'
                : 'presence_persists_no_departure_signal',
        });
    }

    return {
        departed: uniqueMembers(departed),
        evidence,
    };
}

function applyUserDepartureBootstrap(userMessageId, userText) {
    const detection = detectUserDepartureBootstrap(userText);

    logVocaliaEvent('user_departure.detected', {
        userMessageId,
        userText,
        departed: detection.departed.map(memberDebugSummary),
        evidence: detection.evidence,
    });

    for (const member of detection.departed) {
        setPresence(member.avatar, MEMBER_STATUS_ABSENT);

        const state = getChatState();
        if (state.members?.[member.avatar]) {
            state.members[member.avatar].lastStatus = MEMBER_STATUS_DEPARTING;
            state.members[member.avatar].speakingTo = [];
            state.members[member.avatar].lastUserDepartureMessageId = userMessageId;
            state.members[member.avatar].lastUserDepartureAt = Date.now();
        }

        if (state.waitingForUserByAvatar === member.avatar) {
            state.waitingForUserByAvatar = null;
        }

        if (state.lastSpeakerAvatar === member.avatar) {
            state.lastSpeakerAvatar = null;
        }

        state.triggeredThisTurn = (state.triggeredThisTurn ?? []).filter(avatar => avatar !== member.avatar);
    }

    if (detection.departed.length) {
        scrubStaleRoutingReferences(getChatState(), getGroupMembers());
        updateExtensionPrompt();
        updateDiagnosticsPanel();
        saveMetadata();
    }

    return detection.departed;
}

function detectUserSummonBootstrap(text) {
    const source = String(text ?? '');
    const candidates = getAbsentSummonCandidates();
    const aliasEntries = buildSummonAliasEntries(candidates);

    const physical = [];
    const remote = [];
    const evidence = [];

    for (const entry of aliasEntries) {
        const member = entry.member;
        const alias = entry.alias;

        if (isRemoteContactForAlias(source, alias)) {
            remote.push(member);
            evidence.push({
                type: MEMBER_STATUS_REMOTE,
                member: memberDebugSummary(member),
                alias,
            });
            continue;
        }

        if (isPhysicalSummonForAlias(source, alias)) {
            physical.push(member);
            evidence.push({
                type: MEMBER_STATUS_PRESENT,
                member: memberDebugSummary(member),
                alias,
            });
        }
    }

    return {
        physical: uniqueMembers(physical),
        remote: uniqueMembers(remote),
        targets: uniqueMembers([...remote, ...physical]),
        evidence,
    };
}

function applyUserSummonBootstrap(userMessageId, userText) {
    const detection = detectUserSummonBootstrap(userText);

    logVocaliaEvent('user_summon.detected', {
        userMessageId,
        userText,
        physical: detection.physical.map(memberDebugSummary),
        remote: detection.remote.map(memberDebugSummary),
        targets: detection.targets.map(memberDebugSummary),
        evidence: detection.evidence,
    });

    for (const member of detection.physical) {
        setPresence(member.avatar, MEMBER_STATUS_PRESENT);
    }

    for (const member of detection.remote) {
        setPresence(member.avatar, MEMBER_STATUS_REMOTE);
    }

    if (detection.targets.length) {
        updateExtensionPrompt();
        updateDiagnosticsPanel();
        saveMetadata();
    }

    return detection.targets;
}

// ============================================================================
// Section 8. Opening, Existing-Chat, and Empty-Send Target Selection
// ============================================================================
// Purpose:
// - Continue existing chats through prior eligible assistant speakers.
// - Reuse stored speakingTo targets from the last speaker when appropriate.
// - Select empty-send continuation targets without native random group routing.
// - Bootstrap opening user messages with explicit name matches, summons, or fallback.
// ============================================================================

function findMostRecentRouteEligibleAssistantBefore(messageId) {
    const assistantMessages = getAssistantMessagesBefore(messageId).reverse();
    const skipped = [];

    for (const item of assistantMessages) {
        if (isBlankAssistantMessage(item.message)) {
            skipped.push({
                messageId: item.messageId,
                name: item.message?.name ?? null,
                reason: 'blank_message',
            });
            continue;
        }

        const member = getMemberByName(item.message?.name, getGroupMembers());

        if (!member) {
            skipped.push({
                messageId: item.messageId,
                name: item.message?.name ?? null,
                reason: 'not_group_member',
            });
            continue;
        }

        if (!isMemberRouteEligibleCompat(member)) {
            skipped.push({
                messageId: item.messageId,
                member: memberDebugSummary(member),
                reason: 'not_route_eligible',
            });
            continue;
        }

        logVocaliaEvent('existing_chat.prior_assistant_selected', {
            selectedMessageId: item.messageId,
            selectedMember: memberDebugSummary(member),
            skipped,
        });

        return {
            messageId: item.messageId,
            message: item.message,
            member,
            skipped,
        };
    }

    logVocaliaEvent('existing_chat.no_prior_route_eligible_assistant', {
        beforeMessageId: messageId,
        skipped,
    });

    return null;
}

function getStoredSpeakingToTargetsFromSpeakerAvatar(speakerAvatar) {
    const state = ensureStateForCurrentGroup();
    const speakerState = state.members?.[speakerAvatar];

    if (!speakerState || !Array.isArray(speakerState.speakingTo)) return [];

    return uniqueMembers(
        speakerState.speakingTo
            .filter(name => !isUserAlias(name))
            .map(name => getMemberByName(name, getGroupMembers()))
            .filter(Boolean)
            .filter(member => member.avatar !== speakerAvatar)
            .filter(member => isMemberRouteEligibleCompat(member)),
    );
}

function getStoredSpeakingToTargetsFromLastSpeaker() {
    const state = ensureStateForCurrentGroup();

    if (!state.lastSpeakerAvatar) return [];

    return getStoredSpeakingToTargetsFromSpeakerAvatar(state.lastSpeakerAvatar);
}

function getCurrentChatTailMessageId() {
    return Math.max(0, (ctx().chat?.length ?? 1));
}

function selectTargetsForEmptySendContinuation() {
    const settings = getSettings();
    const state = ensureStateForCurrentGroup();

    logVocaliaEvent('empty_send.select.start', {
        chatLength: ctx().chat?.length ?? null,
        state: {
            waitingForUserByAvatar: state.waitingForUserByAvatar,
            lastSpeakerAvatar: state.lastSpeakerAvatar,
            triggeredThisTurn: arrayDebugNames(state.triggeredThisTurn ?? []),
            present: arrayDebugNames(state.present ?? []),
            remote: arrayDebugNames(state.remote ?? []),
            absent: arrayDebugNames(state.absent ?? []),
        },
    });

    const storedTargets = limitTriggerTargets(getStoredSpeakingToTargetsFromLastSpeaker());
    if (storedTargets.length) {
        logVocaliaEvent('empty_send.select.result', {
            strategy: 'last-speaker-stored-speaking-to-targets',
            selected: storedTargets.map(memberDebugSummary),
        });

        return {
            reason: 'empty-send-stored-speaking-to-targets',
            targets: storedTargets,
        };
    }

    if (state.waitingForUserByAvatar) {
        const waitingMember = getMemberByAvatar(state.waitingForUserByAvatar);

        logVocaliaEvent('empty_send.waiting_candidate', {
            waitingForUserByAvatar: state.waitingForUserByAvatar,
            waitingMember: memberDebugSummary(waitingMember),
            eligible: isMemberRouteEligibleCompat(waitingMember),
        });

        if (waitingMember && isMemberRouteEligibleCompat(waitingMember)) {
            return {
                reason: 'empty-send-waiting-for-user',
                targets: [waitingMember],
            };
        }
    }

    const priorAssistant = findMostRecentRouteEligibleAssistantBefore(getCurrentChatTailMessageId());
    if (priorAssistant?.member) {
        return {
            reason: 'empty-send-most-recent-route-eligible-prior-assistant',
            targets: [priorAssistant.member],
        };
    }

    if (state.lastSpeakerAvatar) {
        const lastSpeaker = getMemberByAvatar(state.lastSpeakerAvatar);

        logVocaliaEvent('empty_send.last_speaker_candidate', {
            lastSpeakerAvatar: state.lastSpeakerAvatar,
            lastSpeaker: memberDebugSummary(lastSpeaker),
            eligible: isMemberRouteEligibleCompat(lastSpeaker),
        });

        if (lastSpeaker && isMemberRouteEligibleCompat(lastSpeaker)) {
            return {
                reason: 'empty-send-last-route-eligible-speaker',
                targets: [lastSpeaker],
            };
        }
    }

    const eligibleMembers = getRouteEligibleMembersCompat();

    if (eligibleMembers.length === 1) {
        return {
            reason: 'empty-send-sole-route-eligible-member',
            targets: [eligibleMembers[0]],
        };
    }

    if (settings.firstMessageFallback === FIRST_MESSAGE_FALLBACK_RANDOM_PRESENT && eligibleMembers.length) {
        const randomMember = randomItem(eligibleMembers);
        return {
            reason: 'empty-send-random-route-eligible-fallback',
            targets: randomMember ? [randomMember] : [],
        };
    }

    if (settings.firstMessageFallback === FIRST_MESSAGE_FALLBACK_FIRST_PRESENT && eligibleMembers.length) {
        return {
            reason: 'empty-send-first-route-eligible-fallback',
            targets: eligibleMembers.slice(0, 1),
        };
    }

    return {
        reason: 'empty-send-no-continuation-target',
        targets: [],
    };
}

function selectFirstSpeakerForOpeningUserMessage(userMessageId) {
    const settings = getSettings();
    const userText = getMessageText(userMessageId);
    const eligible = getRouteEligibleMembersCompat();

    logVocaliaEvent('opening.select.start', {
        userMessageId,
        userText,
        triggerNamedCharacterOnFirstUserMessage: settings.triggerNamedCharacterOnFirstUserMessage,
        firstMessageFallback: settings.firstMessageFallback,
        eligibleCandidates: eligible.map(memberDebugSummary),
    });

    const selected = [];

    if (settings.triggerNamedCharacterOnFirstUserMessage) {
        const named = findMentionedPresentMembers(userText);

        logVocaliaEvent('opening.select.name_match', {
            userMessageId,
            userText,
            matchedMembers: named.map(memberDebugSummary),
        });

        selected.push(...named);
    }

    const summoned = applyUserSummonBootstrap(userMessageId, userText);
    selected.push(...summoned);

    const explicitSelected = limitTriggerTargets(selected);
    if (explicitSelected.length) {
        return explicitSelected;
    }

    if (settings.firstMessageFallback === FIRST_MESSAGE_FALLBACK_RANDOM_PRESENT) {
        const member = randomItem(getRouteEligibleMembersCompat());
        return member ? [member] : [];
    }

    if (settings.firstMessageFallback === FIRST_MESSAGE_FALLBACK_FIRST_PRESENT) {
        return getRouteEligibleMembersCompat().slice(0, 1);
    }

    return [];
}

// ============================================================================
// Section 9. Group Reply Strategy Management
// ============================================================================
// Purpose:
// - Force Manual group mode while the router is enabled.
// - Optionally restore the previous group strategy on disable.
// ============================================================================

async function saveGroup(group) {
    if (!group) return false;

    const context = ctx();
    const response = await fetch('/api/groups/edit', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify(group),
    });

    if (!response.ok) {
        warn('Failed to save group settings.', response.status, response.statusText);
        return false;
    }

    return true;
}

async function forceManualStrategyForCurrentGroup() {
    const settings = getSettings();
    if (!settings.enabled || !settings.autoSetManual) return;

    const group = getCurrentGroup();
    if (!group) return;

    const state = getChatState();
    state.originalActivationStrategies ??= {};

    if (!Object.hasOwn(state.originalActivationStrategies, group.id)) {
        state.originalActivationStrategies[group.id] = Number(group.activation_strategy ?? 0);
    }

    if (Number(group.activation_strategy) === GROUP_ACTIVATION_MANUAL) return;

    group.activation_strategy = GROUP_ACTIVATION_MANUAL;
    $('#rm_group_activation_strategy').val(String(GROUP_ACTIVATION_MANUAL)).trigger('input');

    if (await saveGroup(group)) {
        debugToast(`Set ${group.name ?? 'group'} reply strategy to Manual.`);
        await saveMetadata();
    }
}

async function restoreOriginalStrategyForCurrentGroup() {
    const settings = getSettings();
    if (!settings.restoreOriginalStrategyOnDisable) return;

    const group = getCurrentGroup();
    if (!group) return;

    const state = getChatState();
    const original = state.originalActivationStrategies?.[group.id];
    if (!Number.isInteger(Number(original))) return;
    if (Number(group.activation_strategy) === Number(original)) return;

    group.activation_strategy = Number(original);
    $('#rm_group_activation_strategy').val(String(original)).trigger('input');

    if (await saveGroup(group)) debugToast(`Restored ${group.name ?? 'group'} reply strategy.`);
}

// ============================================================================
// Section 10. Router Protocol Prompt Injection
// ============================================================================
// Purpose:
// - Build the Vocalia protocol prompt from editable, labeled instruction fields.
// - Keep injected text concise because prompt tokens are expensive.
// - Instruct the active group member to output one canonical structured block.
// - Make routing metadata strict: exactly one parameters segment, no duplicate keys.
// - Require [parameters] to be inside the active character block.
// - Prevent raw segment text from using Markdown/SillyTavern styling wrappers.
// - Make inner segment closer matching explicit without spending tokens on examples.
// ============================================================================

const VOCALIA_PROTOCOL_SECTION_DEFINITIONS = Object.freeze([
    {
        key: 'header',
        label: 'Protocol Header',
        rows: 2,
        defaultText: '[Vocalia Protocol]',
    },
    {
        key: 'scene_state',
        label: 'Scene State Context',
        rows: 6,
        defaultText: [
            'Members: {{allMembers}}',
            'Present: {{presentMembers}}',
            '{{remoteMembersLine}}',
            '{{absentMembersLine}}',
            'Pending arrivals: {{pendingArrivals}}',
        ].join('\n'),
    },
    {
        key: 'active_speaker',
        label: 'Active Speaker Rules',
        rows: 5,
        defaultText: [
            'Generate as one active group member only.',
            'Output exactly one [{{tagPrefix}}1=Exact Active Speaker Name] block and no text outside it.',
            'The active speaker must be present or remote unless just summoned/contacted by the user.',
            'Never generate as an absent, unreachable character.',
        ].join('\n'),
    },
    {
        key: 'outer_wrapper',
        label: 'Outer Character Wrapper Rules',
        rows: 6,
        defaultText: [
            'Required full message shape:',
            '[{{tagPrefix}}1=Exact Active Speaker Name]',
            '[dialogue/actions/narration/thoughts as needed]',
            '[parameters]...[end parameters]',
            '[end {{tagPrefix}}1]',
            'The [parameters] segment must be inside this same character block.',
        ].join('\n'),
    },
    {
        key: 'segment_rules',
        label: 'Semantic Segment Rules',
        rows: 10,
        defaultText: [
            'Use only these semantic segments, in any order, as needed:',
            '[dialogue]spoken words only[end dialogue]',
            '[actions]active speaker physical action/expression/gesture only[end actions]',
            '[narration]scene/environment/consequences not performed by the active speaker[end narration]',
            '[thoughts]active speaker private thought only[end thoughts]',
            '',
            'Every segment closer must match its opener exactly.',
            'Use one closer style only: [end tag]. Never write [/end tag].',
            'Do not put actions, narration, or thoughts inside dialogue.',
            'Do not wrap segment text in *, **, ***, _, ~, or other style markers.',
            'Segment tags define meaning; Vocalia styles the refined display later.',
        ].join('\n'),
    },
    {
        key: 'parameter_schema',
        label: 'Parameter Segment Schema',
        rows: 5,
        defaultText: [
            'End the character block with exactly one [parameters] segment immediately before [end {{tagPrefix}}1]:',
            '{{parameterSchema}}',
        ].join('\n'),
    },
    {
        key: 'arrival_rules',
        label: 'Arrival Rules',
        rows: 6,
        defaultText: [
            'Arrival rules:',
            '- Use arriving=ExactName when an absent member physically enters, appears, is encountered, is nearby and expected to join, or is called/summoned into the scene.',
            '- A purposeful arrival may speak next when scene logic supports it: speakingTo=ExactName, participationNextTurn=speak.',
            '- If the arrival should not speak yet: arriving=ExactName with participationNextTurn=idle.',
        ].join('\n'),
    },
    {
        key: 'remote_rules',
        label: 'Remote Participation Rules',
        rows: 6,
        defaultText: [
            'Remote rules:',
            '- Use remote=ExactName when an absent member becomes actively reachable by phone, radio, video, intercom, text/DM, or similar channel.',
            '- Remote members are not physically present but may speak if speakingTo names them and participationNextTurn=speak.',
            '- Do not use remote for mere mentions, memories, or speculation.',
        ].join('\n'),
        remoteOnly: true,
    },
    {
        key: 'multi_speaker_rules',
        label: 'Multi-Speaker Routing Rules',
        rows: 6,
        defaultText: [
            'Multi-speaker routing:',
            '- If multiple members should answer this user turn, set speakingTo=ExactName|ExactName and participationNextTurn=speak.',
            '- Name order is trigger order.',
            '- Do not exceed {{maxParticipants}} unique participants, {{maxResponses}} total responses, or {{maxPerParticipant}} response(s) per participant this user turn.',
        ].join('\n'),
    },
    {
        key: 'parameter_behavior',
        label: 'Parameter Behavior Rules',
        rows: 10,
        defaultText: [
            'Parameter rules:',
            '- speakingTo=ExactName|user|none. Use exact group member names; never use user for a group member.',
            '- participationNextTurn=speak lets Vocalia trigger the named eligible member(s).',
            '- participationNextTurn=idle means stop assistant chaining unless later user input needs a response.',
            '- participationNextTurn=departing means the active speaker leaves and becomes absent.',
            '- arriving=ExactName|none only for physical scene entry/encounter/summon.',
            '- remote=ExactName|none only for active remote contact.',
            '- Do not invent names. Do not use departing=.',
            '- When no more assistant response is needed, wait for the user.',
        ].join('\n'),
    },
    {
        key: 'strictness',
        label: 'Strictness Reminder',
        rows: 4,
        defaultText: 'Routing depends on exact syntax: one valid character wrapper, matching segment end tags, one parameters segment inside the character block, required keys, no duplicate parameters, exact names, [end tag] closers only, and unwrapped semantic text.',
        strictOnly: true,
    },
    {
        key: 'footer',
        label: 'Protocol Footer',
        rows: 2,
        defaultText: '[End Vocalia Protocol]',
    },
]);

function getProtocolInstructionSectionDefinitions() {
    return VOCALIA_PROTOCOL_SECTION_DEFINITIONS.map(definition => ({ ...definition }));
}

function getProtocolInstructionDefaultText(key) {
    return VOCALIA_PROTOCOL_SECTION_DEFINITIONS.find(definition => definition.key === key)?.defaultText ?? '';
}

function getProtocolInstructionOverrides(settings = getSettings()) {
    if (!settings.protocolInjectionOverrides || typeof settings.protocolInjectionOverrides !== 'object' || Array.isArray(settings.protocolInjectionOverrides)) {
        settings.protocolInjectionOverrides = {};
    }

    return settings.protocolInjectionOverrides;
}

function getProtocolInstructionTemplate(key, settings = getSettings()) {
    const overrides = getProtocolInstructionOverrides(settings);
    const value = overrides[key];

    if (typeof value === 'string') return value;
    return getProtocolInstructionDefaultText(key);
}

function setProtocolInstructionTemplate(key, value) {
    const settings = getSettings();
    const overrides = getProtocolInstructionOverrides(settings);
    const defaultText = getProtocolInstructionDefaultText(key);
    const nextValue = String(value ?? '');

    if (nextValue === defaultText) {
        delete overrides[key];
    } else {
        overrides[key] = nextValue;
    }

    saveSettings();
    updateExtensionPrompt();
}

function resetProtocolInstructionTemplate(key) {
    const settings = getSettings();
    const overrides = getProtocolInstructionOverrides(settings);

    delete overrides[key];
    saveSettings();
    updateExtensionPrompt();

    return getProtocolInstructionDefaultText(key);
}

function buildProtocolTemplateValues() {
    const group = getCurrentGroup();
    const settings = getSettings();
    const tagPrefix = settings.blockTagPrefix || 'character';
    const members = getGroupMembers(group);
    const present = typeof getPresentMembers === 'function' ? getPresentMembers() : [];
    const remote = typeof getRemoteMembers === 'function' ? getRemoteMembers() : [];
    const absent = getAbsentMembers();
    const pendingNames = (getChatState().pendingArrivals ?? [])
        .map(avatar => getMemberByAvatar(avatar, members)?.name)
        .filter(Boolean)
        .join(', ') || 'none';

    const hasRemoteSupport = typeof getRemoteMembers === 'function';
    const maxParticipants = Math.max(1, Number(settings.maxParticipantsPerTurn) || 1);
    const maxResponses = Math.max(0, Number(settings.maxResponsesPerTurn) || 0);
    const maxPerParticipant = Math.max(1, Number(settings.maxResponsesPerParticipantPerTurn) || 1);

    const parameterSchema = hasRemoteSupport
        ? '[parameters]speakingTo=ExactName|user|none, participationNextTurn=speak|idle|departing, arriving=ExactName|none, remote=ExactName|none[end parameters]'
        : '[parameters]speakingTo=ExactName|user|none, participationNextTurn=speak|idle|departing, arriving=ExactName|none[end parameters]';

    return {
        tagPrefix,
        allMembers: members.map(member => member.name).join(', ') || 'none',
        presentMembers: present.map(member => member.name).join(', ') || 'none',
        remoteMembers: remote.map(member => member.name).join(', ') || 'none',
        absentMembers: absent.map(member => member.name).join(', ') || 'none',
        pendingArrivals: pendingNames,
        remoteMembersLine: hasRemoteSupport ? `Remote: ${remote.map(member => member.name).join(', ') || 'none'}` : '',
        absentMembersLine: hasRemoteSupport
            ? `Absent/unreachable: ${absent.map(member => member.name).join(', ') || 'none'}`
            : `Absent: ${absent.map(member => member.name).join(', ') || 'none'}`,
        parameterSchema,
        maxParticipants: String(maxParticipants),
        maxResponses: String(maxResponses),
        maxPerParticipant: String(maxPerParticipant),
    };
}

function renderProtocolInstructionTemplate(template, values = buildProtocolTemplateValues()) {
    return String(template ?? '').replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_match, key) => {
        if (!Object.hasOwn(values, key)) return '';
        return String(values[key] ?? '');
    });
}

function getProtocolInstructionPreviewText(key) {
    return renderProtocolInstructionTemplate(getProtocolInstructionTemplate(key));
}

function buildInstructionPrompt() {
    const group = getCurrentGroup();
    if (!group) return '';

    const settings = getSettings();
    const hasRemoteSupport = typeof getRemoteMembers === 'function';
    const values = buildProtocolTemplateValues();
    const chunks = [];

    for (const definition of VOCALIA_PROTOCOL_SECTION_DEFINITIONS) {
        if (definition.remoteOnly && !hasRemoteSupport) continue;
        if (definition.strictOnly && !settings.strictPrompt) continue;

        const template = getProtocolInstructionTemplate(definition.key, settings);
        const rendered = renderProtocolInstructionTemplate(template, values).trim();
        if (rendered) chunks.push(rendered);
    }

    return chunks.join('\n\n');
}

function updateExtensionPrompt() {
    const settings = getSettings();
    const context = ctx();
    if (typeof context.setExtensionPrompt !== 'function') return;

    const prompt = settings.enabled && context.groupId ? buildInstructionPrompt() : '';

    try {
        context.setExtensionPrompt(
            MODULE_NAME,
            prompt,
            EXTENSION_PROMPT_POSITION_IN_CHAT,
            Number(settings.promptDepth) || 0,
            !!settings.promptScan,
            Number.isInteger(Number(settings.promptRole)) ? Number(settings.promptRole) : EXTENSION_PROMPT_ROLE_SYSTEM,
        );
    } catch (error) {
        warn('setExtensionPrompt with role failed; retrying legacy signature.', error);
        try {
            context.setExtensionPrompt(
                MODULE_NAME,
                prompt,
                EXTENSION_PROMPT_POSITION_IN_CHAT,
                Number(settings.promptDepth) || 0,
                !!settings.promptScan,
            );
        } catch (secondError) {
            warn('Failed to set extension prompt.', secondError);
        }
    }
}

// ============================================================================
// Section 11. Structured Block Parsing
// ============================================================================
// Purpose:
// - Parse only canonical [character1=Name]...[end character1] blocks.
// - Reject malformed [Name]...[end Name] outer wrappers by returning no blocks.
// - Preserve ordered visible-content segments inside each character block.
// - Accept both [end tag] and [/tag] inner segment closers for robustness.
// - Repair obvious mismatched inner segment closers when the opener is known.
// - Treat duplicate parameter keys as malformed metadata, not as recoverable.
// ============================================================================

const STRUCTURED_SEGMENT_TAGS = Object.freeze([
    SEGMENT_DIALOGUE,
    SEGMENT_ACTIONS,
    SEGMENT_NARRATION,
    SEGMENT_THOUGHTS,
    SEGMENT_PARAMETERS,
]);

function parseTaggedField(body, tagNames) {
    const tags = Array.isArray(tagNames) ? tagNames : [tagNames];

    for (const tag of tags) {
        const escapedTag = escapeRegex(tag);
        const regex = new RegExp(
            `\\[${escapedTag}\\]([\\s\\S]*?)(?:\\[end ${escapedTag}\\]|\\[\\/${escapedTag}\\])`,
            'i',
        );

        const match = regex.exec(body);
        if (match) return String(match[1] ?? '').trim();
    }

    return '';
}

function parseParameters(text) {
    const result = {};
    const raw = String(text ?? '').trim();
    const meta = {
        raw,
        entries: [],
        duplicateKeys: [],
        unknownKeys: [],
        missingRequiredKeys: [],
        malformed: false,
        malformedReasons: [],
    };

    Object.defineProperty(result, '__meta', {
        value: meta,
        enumerable: false,
        configurable: true,
    });

    if (!raw) {
        meta.malformed = true;
        meta.malformedReasons.push('empty_parameters');
        meta.missingRequiredKeys = [...REQUIRED_PARAMETER_KEYS];
        return result;
    }

    const seen = new Set();
    const parts = raw.split(/,(?=\s*[A-Za-z0-9_ -]+\s*=)/g);

    for (const part of parts) {
        const index = part.indexOf('=');
        if (index < 0) {
            meta.malformed = true;
            meta.malformedReasons.push(`parameter_without_equals:${part.trim()}`);
            continue;
        }

        const originalKey = part.slice(0, index).trim();
        const key = normalizeParameterKey(originalKey);
        const value = part.slice(index + 1).trim();

        if (!key) {
            meta.malformed = true;
            meta.malformedReasons.push('empty_parameter_key');
            continue;
        }

        meta.entries.push({
            originalKey,
            key,
            value,
        });

        if (seen.has(key)) {
            if (!meta.duplicateKeys.includes(key)) meta.duplicateKeys.push(key);
            meta.malformed = true;
            meta.malformedReasons.push(`duplicate_parameter:${key}`);
            continue;
        }

        seen.add(key);

        if (!KNOWN_PARAMETER_KEYS.includes(key)) {
            meta.unknownKeys.push(key);
        }

        switch (key) {
            case 'speakingto':
                result.speakingTo = value;
                result.speakingto = value;
                break;

            case 'participationnextturn':
                result.participationNextTurn = value;
                result.participationnextturn = value;
                break;

            case 'arriving':
                result.arriving = value;
                break;

            case 'remote':
                result.remote = value;
                break;

            default:
                result[key] = value;
                break;
        }

        result[originalKey] = value;
    }

    for (const requiredKey of REQUIRED_PARAMETER_KEYS) {
        if (!seen.has(requiredKey)) {
            meta.missingRequiredKeys.push(requiredKey);
        }
    }

    if (meta.missingRequiredKeys.length) {
        meta.malformed = true;
        meta.malformedReasons.push(`missing_required_parameters:${meta.missingRequiredKeys.join('|')}`);
    }

    return result;
}

function buildStructuredSegmentRegex() {
    const tags = STRUCTURED_SEGMENT_TAGS.map(escapeRegex).join('|');

    return new RegExp(
        `\\[(${tags})\\]([\\s\\S]*?)(?:\\[end\\s+(${tags})\\]|\\[\\/(${tags})\\]|\\[\\/end\\s+(${tags})\\])`,
        'gi',
    );
}

function parseOrderedSegments(body) {
    const segmentRegex = buildStructuredSegmentRegex();
    const segments = [];
    const repairs = [];

    let match;
    while ((match = segmentRegex.exec(String(body ?? ''))) !== null) {
        const type = String(match[1] ?? '').trim().toLocaleLowerCase();
        const text = String(match[2] ?? '').trim();
        const closer = String(match[3] ?? match[4] ?? match[5] ?? '').trim().toLocaleLowerCase();
        const rawCloser = String(match[0] ?? '').match(/\[(end\s+[^\]]+|\/[^\]]+|\/end\s+[^\]]+)\]\s*$/i)?.[1] ?? '';
        const mixedCloserStyle = /^\/end\s+/i.test(rawCloser);
        const repaired = (!!closer && closer !== type) || mixedCloserStyle;

        if (repaired) {
            repairs.push({
                opened: type,
                closed: closer,
                rawCloser,
                start: match.index,
                end: segmentRegex.lastIndex,
                preview: String(match[0] ?? '').slice(0, 240),
            });
        }

        segments.push({
            type,
            text,
            raw: match[0],
            start: match.index,
            end: segmentRegex.lastIndex,
            closer,
            repaired,
        });
    }

    Object.defineProperty(segments, '__repairs', {
        value: repairs,
        enumerable: false,
        configurable: true,
    });

    return segments;
}

function getSegmentsText(segments, type) {
    return segments
        .filter(segment => segment.type === type)
        .map(segment => segment.text)
        .filter(Boolean)
        .join('\n\n');
}

function getParameterSegments(segments) {
    return segments.filter(segment => segment.type === SEGMENT_PARAMETERS);
}

function parseStructuredMessage(rawText) {
    const text = String(rawText ?? '');
    const tagPrefix = getSettings().blockTagPrefix || 'character';

    const blockRegex = new RegExp(
        `\\[${escapeRegex(tagPrefix)}([^=\\]]+)=([^\\]]+)\\]([\\s\\S]*?)\\[end ${escapeRegex(tagPrefix)}\\1\\]`,
        'gi',
    );

    const blocks = [];

    let match;
    while ((match = blockRegex.exec(text)) !== null) {
        const token = String(match[1] ?? '').trim();
        const name = String(match[2] ?? '').trim();
        const body = String(match[3] ?? '');
        const segments = parseOrderedSegments(body);
        const segmentRepairs = segments.__repairs ?? [];
        const parameterSegments = getParameterSegments(segments);

        const parametersText = parameterSegments.length
            ? parameterSegments.map(segment => segment.text).join('\n\n')
            : parseTaggedField(body, SEGMENT_PARAMETERS);

        const parameters = parseParameters(parametersText);
        const parameterMeta = parameters.__meta ?? {};

        const malformedReasons = [];

        if (parameterSegments.length !== 1) {
            malformedReasons.push(`parameters_segment_count:${parameterSegments.length}`);
        }

        if (parameterMeta.malformed) {
            malformedReasons.push(...(parameterMeta.malformedReasons ?? []));
        }

        const dialogue = getSegmentsText(segments, SEGMENT_DIALOGUE);
        const actions = getSegmentsText(segments, SEGMENT_ACTIONS);
        const narration = getSegmentsText(segments, SEGMENT_NARRATION);
        const thoughts = getSegmentsText(segments, SEGMENT_THOUGHTS) || parseTaggedField(body, ['thoughts', 'thoughs']);
        const hasVisibleContent = [dialogue, actions, narration, thoughts].some(value => !isBlankText(value));

        if (!hasVisibleContent) {
            malformedReasons.push('no_visible_content');
        }

        if (segmentRepairs.length) {
            logVocaliaEvent('structured_parser.segment_closer_repaired', {
                name,
                token,
                repairs: segmentRepairs,
            });
        }

        const routingMalformed = malformedReasons.length > 0;

        blocks.push({
            token,
            name,
            body,
            segments,
            dialogue,
            actions,
            narration,
            thoughts,
            parametersText,
            parameters,
            parameterMeta,
            parameterSegments,
            segmentRepairs,
            routingMalformed,
            malformedReasons,
            speakingTo: routingMalformed ? [] : splitNameArray(parameters.speakingTo ?? parameters.speakingto ?? 'none'),
            arriving: routingMalformed ? [] : splitNameArray(parameters.arriving ?? 'none'),
            remote: routingMalformed ? [] : splitNameArray(parameters.remote ?? 'none'),
            participationNextTurn: routingMalformed ? 'idle' : normalizeParticipationStatus(
                parameters.participationNextTurn
                ?? parameters.participationnextturn
                ?? parameters.nextTurn
                ?? parameters.nextturn
                ?? parameters.status
                ?? 'idle',
            ),
            raw: match[0],
            start: match.index,
            end: blockRegex.lastIndex,
        });
    }

    return blocks;
}

function firstValidOwnerBlock(blocks, message) {
    if (!blocks.length) return null;

    const members = getGroupMembers();
    const messageName = normalizeName(message?.name ?? '');
    const ownerMatch = blocks.find(block => normalizeName(block.name) === messageName);
    if (ownerMatch) return ownerMatch;

    return blocks.find(block => !!getMemberByName(block.name, members)) ?? blocks[0];
}

// ============================================================================
// Section 12. Display Overlay Rendering
// ============================================================================
// Purpose:
// - Preserve raw structured content in chat history.
// - Render parsed blocks as semantic HTML.
// - Respect ordered dialogue/actions/narration/thoughts segments.
// - Support refined-message display styles from drawer settings.
// - Strip accidental raw SillyTavern/Markdown wrappers from semantic segments.
// - Use CSS for all refined-message styles except Muted Italics.
// - Use SillyTavern's native asterisk formatting only for Muted Italics.
// - Avoid passing the full reconstructed message through Markdown as one blob.
// ============================================================================

function normalizePlainSegmentText(value) {
    return String(value ?? '').trim();
}

function stripOneBalancedOuterQuotePair(value) {
    let text = normalizePlainSegmentText(value);
    if (!text) return '';

    const quotePairs = [
        ['"', '"'],
        ['“', '”'],
        ['‘', '’'],
        ["'", "'"],
    ];

    for (const [open, close] of quotePairs) {
        if (text.startsWith(open) && text.endsWith(close)) {
            return text.slice(open.length, text.length - close.length).trim();
        }
    }

    return text;
}

function stripOneBalancedOuterAsteriskWrapper(value) {
    const text = normalizePlainSegmentText(value);
    if (!text) return '';

    for (const marker of ['***', '**', '*']) {
        if (
            text.length > marker.length * 2
            && text.startsWith(marker)
            && text.endsWith(marker)
        ) {
            return text.slice(marker.length, text.length - marker.length).trim();
        }
    }

    return text;
}

function stripAccidentalRawSegmentFormatting(value) {
    let text = normalizePlainSegmentText(value);
    if (!text) return '';

    for (let index = 0; index < 3; index += 1) {
        const stripped = stripOneBalancedOuterAsteriskWrapper(text);
        if (stripped === text) break;
        text = stripped;
    }

    return text;
}

function buildDialogueDisplayText(value) {
    const text = stripOneBalancedOuterQuotePair(value);
    if (!text) return '';

    return getSettings().quoteDialogue ? `"${text}"` : text;
}

function normalizeOverlayStyle(style) {
    const value = String(style ?? '').trim();

    if (value === 'none') return OVERLAY_STYLE_PLAIN;
    if (value === 'muted_italics') return OVERLAY_STYLE_ASTERISKS;

    const allowed = new Set([
        OVERLAY_STYLE_PLAIN,
        'muted',

        OVERLAY_STYLE_BOLD,
        OVERLAY_STYLE_ITALIC,
        OVERLAY_STYLE_BOLD_ITALIC,
        'muted_bold',
        OVERLAY_STYLE_ASTERISKS,

        OVERLAY_STYLE_UNDERLINE,
        'muted_underline',

        OVERLAY_STYLE_STRIKE,
        'muted_strike',

        OVERLAY_STYLE_UPPERCASE,
        'muted_uppercase',

        OVERLAY_STYLE_LOWERCASE,
        'muted_lowercase',
    ]);

    return allowed.has(value) ? value : OVERLAY_STYLE_PLAIN;
}

function buildStyledSegmentDisplayText(value, displayStyle) {
    const text = stripAccidentalRawSegmentFormatting(value);
    if (!text) return '';

    const normalizedStyle = normalizeOverlayStyle(displayStyle);

    switch (normalizedStyle) {
        case OVERLAY_STYLE_UPPERCASE:
        case 'muted_uppercase':
            return text.toLocaleUpperCase();

        case OVERLAY_STYLE_LOWERCASE:
        case 'muted_lowercase':
            return text.toLocaleLowerCase();

        case OVERLAY_STYLE_ASTERISKS:
        case OVERLAY_STYLE_BOLD:
        case OVERLAY_STYLE_BOLD_ITALIC:
        case OVERLAY_STYLE_ITALIC:
        case OVERLAY_STYLE_UNDERLINE:
        case OVERLAY_STYLE_STRIKE:
        case OVERLAY_STYLE_PLAIN:
        case 'muted':
        case 'muted_bold':
        case 'muted_underline':
        case 'muted_strike':
        default:
            return text;
    }
}

function buildNativeMutedItalicsDisplayText(value) {
    const text = stripAccidentalRawSegmentFormatting(value);
    if (!text) return '';

    return `*${text}*`;
}

function shouldUseSillyTavernFormattingForSegment(segmentType, displayStyle) {
    if (segmentType === SEGMENT_DIALOGUE) {
        return !!getSettings().quoteDialogue;
    }

    return normalizeOverlayStyle(displayStyle) === OVERLAY_STYLE_ASTERISKS;
}

function shouldShowRefinedCharacterName(settings = getSettings()) {
    if (Object.hasOwn(settings, 'hideCharacterNameInRefinedMessage')) {
        return !Boolean(settings.hideCharacterNameInRefinedMessage);
    }

    return !!settings.showCharacterLabels;
}

function shouldShowRefinedThoughts(settings = getSettings()) {
    if (Object.hasOwn(settings, 'hideThoughtsInRefinedMessage')) {
        return !Boolean(settings.hideThoughtsInRefinedMessage);
    }

    return !!settings.showThoughts;
}

function createOverlaySpan(className, text) {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    return span;
}

function createFormattedSegmentElement(className, displayText, message, messageId, fallbackText = displayText) {
    const span = document.createElement('span');
    span.className = `${className} aspect-vocalia-formatted`;

    const context = ctx();

    if (typeof context.messageFormatting === 'function') {
        try {
            span.innerHTML = context.messageFormatting(
                displayText,
                message.name,
                !!message.is_system,
                !!message.is_user,
                Number(messageId),
            );
            return span;
        } catch (error) {
            warn('SillyTavern segment formatting failed; falling back to textContent.', error);
        }
    }

    span.textContent = fallbackText;
    return span;
}

function appendStyledNonDialogueSegment(parent, segment, message, messageId, segmentClassName, displayStyle) {
    const normalizedStyle = normalizeOverlayStyle(displayStyle);
    const rawText = normalizePlainSegmentText(segment.text);
    if (!rawText) return;

    const cleanText = stripAccidentalRawSegmentFormatting(rawText);
    if (!cleanText) return;

    const paragraph = document.createElement('div');
    paragraph.className = `aspect-vocalia-segment aspect-vocalia-segment-${segment.type}`;
    paragraph.dataset.displayStyle = normalizedStyle;

    if (shouldUseSillyTavernFormattingForSegment(segment.type, normalizedStyle)) {
        paragraph.append(createFormattedSegmentElement(
            segmentClassName,
            buildNativeMutedItalicsDisplayText(cleanText),
            message,
            messageId,
            cleanText,
        ));
    } else {
        paragraph.append(createOverlaySpan(
            segmentClassName,
            buildStyledSegmentDisplayText(cleanText, normalizedStyle),
        ));
    }

    parent.append(paragraph);
}

function appendSegmentElement(parent, segment, block, message, messageId) {
    const settings = getSettings();
    const rawText = normalizePlainSegmentText(segment.text);
    if (!rawText) return;

    switch (segment.type) {
        case SEGMENT_DIALOGUE: {
            const displayText = buildDialogueDisplayText(rawText);
            if (!displayText) return;

            const paragraph = document.createElement('div');
            paragraph.className = `aspect-vocalia-segment aspect-vocalia-segment-${segment.type}`;
            paragraph.dataset.displayStyle = OVERLAY_STYLE_PLAIN;

            if (settings.quoteDialogue) {
                paragraph.append(createFormattedSegmentElement(
                    'aspect-vocalia-dialogue',
                    displayText,
                    message,
                    messageId,
                    displayText,
                ));
            } else {
                paragraph.append(createOverlaySpan('aspect-vocalia-dialogue', displayText));
            }

            parent.append(paragraph);
            break;
        }

        case SEGMENT_ACTIONS:
            appendStyledNonDialogueSegment(
                parent,
                segment,
                message,
                messageId,
                'aspect-vocalia-actions',
                settings.actionDisplayStyle,
            );
            break;

        case SEGMENT_NARRATION:
            appendStyledNonDialogueSegment(
                parent,
                segment,
                message,
                messageId,
                'aspect-vocalia-narration',
                settings.narrationDisplayStyle,
            );
            break;

        case SEGMENT_THOUGHTS:
            if (!shouldShowRefinedThoughts(settings)) return;

            appendStyledNonDialogueSegment(
                parent,
                segment,
                message,
                messageId,
                'aspect-vocalia-thoughts',
                settings.thoughtsDisplayStyle,
            );
            break;

        case SEGMENT_PARAMETERS:
        default:
            return;
    }
}

function createBlockOverlayElement(block, message, messageId) {
    const settings = getSettings();
    const blockElement = document.createElement('div');
    blockElement.className = 'aspect-vocalia-block';

    if (shouldShowRefinedCharacterName(settings)) {
        const label = document.createElement('div');
        label.className = 'aspect-vocalia-character-label';
        label.textContent = block.name;
        blockElement.append(label);
    }

    const visibleSegments = (block.segments ?? []).filter(segment => segment.type !== SEGMENT_PARAMETERS);

    if (visibleSegments.length) {
        for (const segment of visibleSegments) {
            appendSegmentElement(blockElement, segment, block, message, messageId);
        }
    } else if (!settings.hideEmptySections) {
        const empty = document.createElement('div');
        empty.className = 'aspect-vocalia-segment aspect-vocalia-empty';
        empty.textContent = '...';
        blockElement.append(empty);
    }

    return blockElement;
}

function createStructuredOverlayFragment(message, messageId) {
    const blocks = parseStructuredMessage(message?.mes ?? '');
    if (!blocks.length) return null;

    const fragment = document.createDocumentFragment();

    for (const block of blocks) {
        fragment.append(createBlockOverlayElement(block, message, messageId));
    }

    return fragment;
}

function getMessageElementAndTextElement(messageId) {
    const id = Number(messageId);
    const messageElement = $(`#chat .mes[mesid="${id}"]`);
    const textElement = messageElement.find('.mes_text').first();

    return {
        id,
        messageElement,
        textElement,
        exists: !!messageElement.length && !!textElement.length,
    };
}

function resetMessageOverlay(messageId) {
    const { messageElement, textElement, exists } = getMessageElementAndTextElement(messageId);
    if (!exists) return;

    const originalHtml = textElement.attr('data-aspect-vocalia-original-html');

    if (originalHtml !== undefined) {
        textElement.html(originalHtml);
        textElement.removeAttr('data-aspect-vocalia-original-html');
    }

    messageElement.removeAttr('data-aspect-vocalia-rendered');
}

function renderMessageOverlay(messageId) {
    const settings = getSettings();
    const message = ctx().chat?.[Number(messageId)];

    if (!message || message.is_user || message.is_system) return;

    if (!settings.renderOverlay) {
        resetMessageOverlay(messageId);
        return;
    }

    const { messageElement, textElement, exists } = getMessageElementAndTextElement(messageId);
    if (!exists) return;

    const fragment = createStructuredOverlayFragment(message, messageId);
    if (!fragment) {
        resetMessageOverlay(messageId);
        return;
    }

    if (textElement.attr('data-aspect-vocalia-original-html') === undefined) {
        textElement.attr('data-aspect-vocalia-original-html', textElement.html());
    }

    textElement.empty().append(fragment);
    messageElement.attr('data-aspect-vocalia-rendered', 'true');
}

function renderAllVisibleOverlays() {
    const chat = ctx().chat ?? [];

    for (let messageId = 0; messageId < chat.length; messageId += 1) {
        const message = chat[messageId];
        if (!message || message.is_user || message.is_system) continue;

        renderMessageOverlay(messageId);
    }
}

function applyOverlaySettingToVisibleMessages() {
    const chat = ctx().chat ?? [];

    if (getSettings().renderOverlay) {
        renderAllVisibleOverlays();
        return;
    }

    for (let messageId = 0; messageId < chat.length; messageId += 1) {
        resetMessageOverlay(messageId);
    }
}

// ============================================================================
// Section 13. Routing State Transitions
// ============================================================================
// Purpose:
// - Apply parsed owner parameters to scene state.
// - Refuse routing/state transitions from absent, non-remote owners.
// - Resolve next speakers from speakingTo and present/remote/absent membership.
// - Preserve idle semantics.
// - Apply physical arrivals whenever a valid route-eligible owner declares them.
// - Support multiple next-speaker targets from one owner block.
// - Refuse malformed routing metadata, including duplicate parameters.
// ============================================================================

function stageArrivals(members) {
    const state = getChatState();
    state.pendingArrivals ??= [];

    logVocaliaEvent('arrivals.stage.start', {
        arrivals: members.map(memberDebugSummary),
    });

    for (const member of members) {
        if (!member || member.disabled) continue;

        const alreadyPresent = typeof isAvatarActuallyPresent === 'function'
            ? isAvatarActuallyPresent(member.avatar, state)
            : (state.present ?? []).includes(member.avatar);

        if (!state.pendingArrivals.includes(member.avatar) && !alreadyPresent) {
            state.pendingArrivals.push(member.avatar);
        }
    }

    if (typeof normalizeRosterArrays === 'function') {
        normalizeRosterArrays(state, getGroupMembers());
        updateMemberPresenceFlags(state, getGroupMembers());
    } else {
        state.pendingArrivals = [...new Set(state.pendingArrivals ?? [])];
    }

    logVocaliaEvent('arrivals.stage.end', {
        pendingArrivals: arrayDebugNames(state.pendingArrivals),
    });
}

function applyPendingArrivals() {
    const state = getChatState();
    const pending = [...new Set(state.pendingArrivals ?? [])];

    logVocaliaEvent('arrivals.apply_pending.start', {
        pendingArrivals: arrayDebugNames(pending),
    });

    if (!pending.length) return [];

    const arrived = [];
    for (const avatar of pending) {
        if (state.members?.[avatar]) {
            setPresence(avatar, MEMBER_STATUS_PRESENT);
            arrived.push(avatar);
        }
    }

    state.pendingArrivals = [];

    if (typeof normalizeRosterArrays === 'function') {
        normalizeRosterArrays(state, getGroupMembers());
        updateMemberPresenceFlags(state, getGroupMembers());
        scrubStaleRoutingReferences(state, getGroupMembers());
    }

    logVocaliaEvent('arrivals.apply_pending.end', {
        arrived: arrayDebugNames(arrived),
    });

    return arrived;
}

function isOwnerEligibleForStateTransitions(ownerMember) {
    if (!ownerMember || ownerMember.disabled) return false;
    return isMemberRouteEligibleCompat(ownerMember);
}

function applyDeclaredArrivals(block) {
    const settings = getSettings();

    if (block?.routingMalformed) {
        logVocaliaEvent('arrivals.declared.refused', {
            reason: 'malformed_routing_metadata',
            malformedReasons: block.malformedReasons ?? [],
            parametersText: block.parametersText ?? '',
        });

        return [];
    }

    const arrivals = resolveNamesToMembers(block.arriving ?? []);

    logVocaliaEvent('arrivals.declared.start', {
        arrivingRaw: block.arriving ?? [],
        resolvedArrivals: arrivals.map(memberDebugSummary),
        arrivalApplyMode: settings.arrivalApplyMode,
    });

    if (!arrivals.length) {
        logVocaliaEvent('arrivals.declared.end', {
            applied: [],
            staged: [],
            reason: 'no_arrivals',
        });

        return [];
    }

    stageArrivals(arrivals);

    if (settings.arrivalApplyMode === ARRIVAL_APPLY_IMMEDIATE) {
        const applied = applyPendingArrivals()
            .map(avatar => getMemberByAvatar(avatar))
            .filter(Boolean);

        logVocaliaEvent('arrivals.declared.end', {
            applied: applied.map(memberDebugSummary),
            staged: [],
            arrivalApplyMode: settings.arrivalApplyMode,
        });

        return applied;
    }

    logVocaliaEvent('arrivals.declared.end', {
        applied: [],
        staged: arrivals.map(memberDebugSummary),
        arrivalApplyMode: settings.arrivalApplyMode,
    });

    return arrivals;
}

function applyFirstAssistantArrivals(block) {
    return applyDeclaredArrivals(block);
}

function applyRemoteContacts(block) {
    if (typeof getRemoteMembers !== 'function') return [];

    if (block?.routingMalformed) {
        logVocaliaEvent('remote.apply.refused', {
            reason: 'malformed_routing_metadata',
            malformedReasons: block.malformedReasons ?? [],
            parametersText: block.parametersText ?? '',
        });

        return [];
    }

    const state = getChatState();
    const remotes = resolveNamesToMembers(block.remote ?? []);

    logVocaliaEvent('remote.apply.start', {
        remoteRaw: block.remote ?? [],
        resolvedRemote: remotes.map(memberDebugSummary),
    });

    for (const member of remotes) {
        if (!member || member.disabled) continue;
        if (typeof isAvatarActuallyPresent === 'function' && isAvatarActuallyPresent(member.avatar, state)) continue;
        setPresence(member.avatar, MEMBER_STATUS_REMOTE);
    }

    if (typeof normalizeRosterArrays === 'function') {
        normalizeRosterArrays(state, getGroupMembers());
        updateMemberPresenceFlags(state, getGroupMembers());
        scrubStaleRoutingReferences(state, getGroupMembers());
    }

    logVocaliaEvent('remote.apply.end', {
        remote: arrayDebugNames(getChatState().remote ?? []),
    });

    return remotes;
}

function isMemberRouteEligibleForBlock(member, state = getChatState()) {
    if (!member || member.disabled) return false;

    if (typeof isAvatarRouteEligible === 'function') return isAvatarRouteEligible(member.avatar, state);
    if (typeof isAvatarActuallyPresent === 'function') return isAvatarActuallyPresent(member.avatar, state);

    return (
        (state.present ?? []).includes(member.avatar)
        && !(state.absent ?? []).includes(member.avatar)
        && !(state.pendingArrivals ?? []).includes(member.avatar)
    );
}

function validTargetsFromBlock(block, ownerMember) {
    const state = getChatState();
    const settings = getSettings();

    if (block?.routingMalformed) {
        logVocaliaEvent('targets.validate.refused', {
            owner: memberDebugSummary(ownerMember),
            reason: 'malformed_routing_metadata',
            malformedReasons: block.malformedReasons ?? [],
            parametersText: block.parametersText ?? '',
        });

        return [];
    }

    const requested = resolveNamesToMembers(block.speakingTo);

    const evaluations = requested.map(member => {
        let accepted = true;
        const reasons = [];

        if (!member) {
            accepted = false;
            reasons.push('missing_member');
        } else {
            if (member.disabled) {
                accepted = false;
                reasons.push('disabled');
            }

            if (ownerMember && member.avatar === ownerMember.avatar) {
                accepted = false;
                reasons.push('same_as_owner');
            }

            if (!isMemberRouteEligibleForBlock(member, state)) {
                accepted = false;
                reasons.push(typeof isAvatarRouteEligible === 'function' ? 'not_present_or_remote' : 'not_present');
            }

            if ((state.absent ?? []).includes(member.avatar)) {
                reasons.push('in_absent_array');
            }

            if ((state.pendingArrivals ?? []).includes(member.avatar)) {
                reasons.push('pending_arrival');
            }
        }

        return {
            member: memberDebugSummary(member),
            accepted,
            reasons,
        };
    });

    const acceptedTargets = limitTriggerTargets(requested.filter(member => {
        if (!member || member.disabled) return false;
        if (ownerMember && member.avatar === ownerMember.avatar) return false;
        return isMemberRouteEligibleForBlock(member, state);
    }));

    logVocaliaEvent('targets.validate', {
        owner: memberDebugSummary(ownerMember),
        speakingToRaw: block.speakingTo,
        requested: requested.map(memberDebugSummary),
        evaluations,
        acceptedTargets: acceptedTargets.map(memberDebugSummary),
        maxTriggersPerMessage: settings.maxTriggersPerMessage,
    });

    return acceptedTargets;
}

function updateWaitingForUser(block, ownerMember) {
    const state = getChatState();

    if (!ownerMember) {
        state.waitingForUserByAvatar = null;

        logVocaliaEvent('waiting_for_user.update', {
            owner: null,
            waitingForUserByAvatar: null,
            reason: 'missing_owner',
        });

        return;
    }

    if (block?.routingMalformed) {
        logVocaliaEvent('waiting_for_user.update.refused', {
            owner: memberDebugSummary(ownerMember),
            reason: 'malformed_routing_metadata',
            malformedReasons: block.malformedReasons ?? [],
            previousWaitingForUserByAvatar: state.waitingForUserByAvatar,
        });

        return;
    }

    const addressedUser = block.speakingTo.some(isUserAlias);
    const ownerDeparting = block.participationNextTurn === 'departing';
    const waitingForUser = addressedUser && !ownerDeparting;

    state.waitingForUserByAvatar = waitingForUser ? ownerMember.avatar : null;

    logVocaliaEvent('waiting_for_user.update', {
        owner: memberDebugSummary(ownerMember),
        participationNextTurn: block.participationNextTurn,
        speakingToRaw: block.speakingTo,
        addressedUser,
        ownerDeparting,
        waitingForUser,
        waitingForUserByAvatar: state.waitingForUserByAvatar,
    });
}

function updateOwnerSeenState(block, ownerMember, messageId) {
    const state = getChatState();
    const ownerState = state.members[ownerMember.avatar] ?? {};

    state.members[ownerMember.avatar] = {
        ...ownerState,
        avatar: ownerMember.avatar,
        name: ownerMember.name,
        chid: ownerMember.chid,
        groupIndex: ownerMember.groupIndex,
        disabled: !!ownerMember.disabled,
        presence: state.members[ownerMember.avatar]?.presence
            ?? (state.present?.includes(ownerMember.avatar) ? MEMBER_STATUS_PRESENT : MEMBER_STATUS_ABSENT),
        lastStatus: block.routingMalformed ? ownerState.lastStatus ?? MEMBER_STATUS_IDLE : block.participationNextTurn,
        speakingTo: block.routingMalformed ? ownerState.speakingTo ?? [] : block.speakingTo,
        lastSeenMessageId: messageId,
        lastDialogueMessageId: block.dialogue ? messageId : ownerState.lastDialogueMessageId,
        lastActionMessageId: block.actions ? messageId : ownerState.lastActionMessageId,
        lastMalformedMessageId: block.routingMalformed ? messageId : ownerState.lastMalformedMessageId,
        lastMalformedReasons: block.routingMalformed ? block.malformedReasons ?? [] : ownerState.lastMalformedReasons,
    };

    state.lastSpeakerAvatar = ownerMember.avatar;
}

function getAssistantCountSinceLatestUserFromChat(messageId = null) {
    const chat = ctx().chat ?? [];
    const end = Number.isInteger(Number(messageId))
        ? Math.min(Number(messageId), chat.length - 1)
        : chat.length - 1;

    if (end < 0) return 0;

    let count = 0;

    for (let i = end; i >= 0; i -= 1) {
        const message = chat[i];
        if (!message || message.is_system) continue;
        if (message.is_user) break;
        count += 1;
    }

    return count;
}

function syncAssistantCountSinceUserFromChat(messageId = null, reason = 'sync') {
    const state = getChatState();
    const previous = Number(state.assistantCountSinceUser || 0);
    const next = getAssistantCountSinceLatestUserFromChat(messageId);

    state.assistantCountSinceUser = next;

    if (previous !== next) {
        logVocaliaEvent('assistant_count.synced', {
            reason,
            messageId: Number.isInteger(Number(messageId)) ? Number(messageId) : null,
            previous,
            next,
            chatLength: ctx().chat?.length ?? null,
        });
    }

    return next;
}

function applyOwnerBlockToState(block, ownerMember, messageId, firstAssistantForUserMessage) {
    const state = ensureStateForCurrentGroup();

    logVocaliaEvent('owner_block.apply.start', {
        messageId,
        firstAssistantForUserMessage,
        owner: memberDebugSummary(ownerMember),
        ownerRouteEligible: isOwnerEligibleForStateTransitions(ownerMember),
        block: block ? {
            name: block.name,
            routingMalformed: !!block.routingMalformed,
            malformedReasons: block.malformedReasons ?? [],
            participationNextTurn: block.participationNextTurn,
            speakingTo: block.speakingTo,
            arriving: block.arriving,
            remote: block.remote ?? [],
            dialoguePreview: String(block.dialogue ?? '').slice(0, 500),
            actionsPreview: String(block.actions ?? '').slice(0, 500),
            narrationPreview: String(block.narration ?? '').slice(0, 500),
            thoughtsPreview: String(block.thoughts ?? '').slice(0, 500),
            parametersText: block.parametersText,
            segmentTypes: (block.segments ?? []).map(segment => segment.type),
        } : null,
    });

    if (!block || !ownerMember) {
        warn(`Ignoring block for unknown owner: ${block?.name ?? 'none'}`);

        logVocaliaEvent('owner_block.apply.refused', {
            messageId,
            reason: 'missing_block_or_owner',
            blockName: block?.name ?? null,
        });

        return [];
    }

    if (!isOwnerEligibleForStateTransitions(ownerMember)) {
        logVocaliaEvent('owner_block.apply.refused_non_route_eligible_owner', {
            messageId,
            owner: memberDebugSummary(ownerMember),
            reason: 'owner_not_present_or_remote',
            note: 'Visible text may render, but routing/state transitions are refused from absent non-remote owners.',
        });

        return [];
    }

    updateOwnerSeenState(block, ownerMember, messageId);

    if (block.routingMalformed) {
        logVocaliaEvent('owner_block.apply.malformed_metadata_refused', {
            messageId,
            owner: memberDebugSummary(ownerMember),
            malformedReasons: block.malformedReasons ?? [],
            parametersText: block.parametersText ?? '',
            note: 'Visible text was accepted for display, but routing/state transitions were refused.',
        });

        state.lastParsedMessageId = messageId;
        syncAssistantCountSinceUserFromChat(messageId, 'malformed_owner_block');
        return [];
    }

    applyDeclaredArrivals(block);
    applyRemoteContacts(block);

    updateWaitingForUser(block, ownerMember);

    let targets = [];
    if (block.participationNextTurn === 'speak') {
        targets = validTargetsFromBlock(block, ownerMember);
    }

    if (block.participationNextTurn === 'departing') {
        setPresence(ownerMember.avatar, MEMBER_STATUS_ABSENT);
    }

    state.lastParsedMessageId = messageId;
    syncAssistantCountSinceUserFromChat(messageId, 'owner_block_applied');

    logVocaliaEvent('owner_block.apply.end', {
        messageId,
        owner: memberDebugSummary(ownerMember),
        targets: targets.map(memberDebugSummary),
        ownerDeparted: block.participationNextTurn === 'departing',
        waitingForUserByAvatar: state.waitingForUserByAvatar,
        arrivingAppliedFromAnyResponse: true,
    });

    return targets;
}

// ============================================================================
// Section 14. Trigger Execution
// ============================================================================
// Purpose:
// - Invoke /trigger silently when possible.
// - Fall back to force_chid generation if slash execution fails.
// ============================================================================

function quoteSlashArg(value) {
    const text = String(value ?? '').replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    return `"${text}"`;
}

async function triggerBySlash(member) {
    const context = ctx();
    const command = `/trigger ${quoteSlashArg(member.name)}`;

    if (typeof context.executeSlashCommandsWithOptions === 'function') {
        try {
            await context.executeSlashCommandsWithOptions(command, {
                handleParserErrors: true,
                quiet: true,
                abortController: new AbortController(),
            });
            return;
        } catch (error) {
            warn('executeSlashCommandsWithOptions failed; trying legacy slash command execution.', error);
        }
    }

    if (typeof context.executeSlashCommands === 'function') {
        await context.executeSlashCommands(command);
        return;
    }

    throw new Error('No slash command executor is available in this SillyTavern context.');
}

async function triggerByInternalGenerate(member) {
    const context = ctx();

    if (typeof context.generate === 'function') {
        await context.generate('normal', { force_chid: member.chid });
        return;
    }

    if (typeof globalThis.Generate === 'function') {
        await globalThis.Generate('normal', { force_chid: member.chid });
        return;
    }

    throw new Error('No internal generation API is available in this SillyTavern context.');
}

async function triggerMember(member) {
    const settings = getSettings();

    if (!member || !Number.isInteger(Number(member.chid))) {
        throw new Error(`Invalid trigger target: ${member?.name ?? 'unknown'}`);
    }

    if (settings.useSlashTrigger) {
        try {
            await triggerBySlash(member);
            return;
        } catch (error) {
            warn(`/trigger failed for ${member.name}.`, error);
            if (!settings.fallbackToInternalGenerate) throw error;
        }
    }

    await triggerByInternalGenerate(member);
}

// ============================================================================
// Section 15. Trigger Queue and Chain Control
// ============================================================================
// Purpose:
// - Serialize group member triggers.
// - Enforce true per-turn unique-participant and total-response limits.
// - Enforce per-participant response limits.
// - Persist allowance counts without migration wiping live turn state.
// - Wait for the triggered assistant's actual MESSAGE_RECEIVED before continuing.
// - Expose the active target avatar for the generate_interceptor.
// - Clean up pending trigger waiters only when generation is explicitly stopped,
//   aborted, timed out, or invalidated by chat/group changes.
// - Treat GENERATION_ENDED as observational only; it is not proof that no
//   MESSAGE_RECEIVED will arrive.
// - Handle deferred-arrival application at chain end.
// - Validate route eligibility against physical-present OR remote members.
// ============================================================================

function setActiveGenerationTarget(member, reason = 'unspecified') {
    vocaliaActiveGenerationTargetAvatar = member?.avatar ?? null;
    vocaliaActiveGenerationTargetName = member?.name ?? null;
    vocaliaActiveGenerationTargetStartedAt = Date.now();
    vocaliaActiveGenerationTargetReason = reason;

    logVocaliaEvent('generation_target.set', {
        member: memberDebugSummary(member),
        reason,
    });
}

function clearActiveGenerationTarget(reason = 'unspecified') {
    logVocaliaEvent('generation_target.clear', {
        reason,
        previous: {
            avatar: vocaliaActiveGenerationTargetAvatar,
            name: vocaliaActiveGenerationTargetName,
            startedAt: vocaliaActiveGenerationTargetStartedAt,
            targetReason: vocaliaActiveGenerationTargetReason,
        },
    });

    vocaliaActiveGenerationTargetAvatar = null;
    vocaliaActiveGenerationTargetName = null;
    vocaliaActiveGenerationTargetStartedAt = null;
    vocaliaActiveGenerationTargetReason = null;
}

function getActiveGenerationTargetMember() {
    if (!vocaliaActiveGenerationTargetAvatar) return null;
    return getMemberByAvatar(vocaliaActiveGenerationTargetAvatar, getGroupMembers());
}

function recordTriggerAttemptInterrupted(attempt, reason = 'generation_interrupted') {
    if (!attempt) return null;

    attempt.stage = 'interrupted';
    attempt.interruptedAtMs = Date.now();
    attempt.interruptedAtIso = new Date().toISOString();
    attempt.endedAtMs = attempt.interruptedAtMs;
    attempt.endedAtIso = attempt.interruptedAtIso;
    attempt.chatLengthAfter = ctx().chat?.length ?? null;
    attempt.completed = false;
    attempt.failed = true;
    attempt.timedOut = false;
    attempt.error = {
        name: 'VocaliaGenerationInterrupted',
        message: String(reason || 'generation_interrupted'),
    };

    logVocaliaEvent('trigger.attempt.interrupted', {
        attempt: safeLogClone(attempt),
        reason,
    });

    return attempt;
}

function resolvePendingTriggerWaitersFromExistingTail(reason = 'generation_lifecycle_check') {
    const context = ctx();
    const chat = context.chat ?? [];
    const lastMessageId = chat.length - 1;
    const lastMessage = chat[lastMessageId];

    if (!lastMessage || lastMessage.is_user || lastMessage.is_system) return [];

    const resolved = resolvePendingTriggerWaitersForMessage(lastMessageId, lastMessage);

    if (resolved.length) {
        logVocaliaEvent('trigger.waiter.resolved_from_existing_tail', {
            reason,
            messageId: lastMessageId,
            message: getMessageDebugSummary(lastMessageId),
            resolved: resolved.map(item => ({
                status: item.status,
                attemptId: item.attempt?.id ?? null,
                memberName: item.attempt?.memberName ?? null,
            })),
        });
    }

    return resolved;
}

function resolvePendingTriggerWaitersAsInterrupted(reason = 'generation_interrupted', eventValue = null) {
    if (!hasPendingTriggerWaiters()) return [];

    resolvePendingTriggerWaitersFromExistingTail(`${reason}:tail_check`);
    if (!hasPendingTriggerWaiters()) return [];

    const activeAvatar = vocaliaActiveGenerationTargetAvatar;
    const matching = activeAvatar
        ? vocaliaPendingTriggerWaiters.filter(waiter => waiter.memberAvatar === activeAvatar)
        : [...vocaliaPendingTriggerWaiters];

    if (!matching.length) return [];

    const resolved = [];

    for (const waiter of matching) {
        recordTriggerAttemptInterrupted(waiter.attempt, reason);
        unmarkTriggeredThisTurn(waiter.memberAvatar, reason);

        const result = {
            status: 'generation_interrupted',
            attempt: waiter.attempt,
            messageId: null,
            message: null,
            reason,
        };

        resolved.push(result);
        resolveTriggeredWaiter(waiter, result);
    }

    triggerQueue = [];
    queueRunning = false;

    clearActiveGenerationTarget(reason);
    maybeApplyDeferredArrivalsAtChainEnd();
    updateDiagnosticsPanel();
    saveMetadata();

    logVocaliaEvent('trigger.waiter.resolved_by_generation_interrupted', {
        reason,
        eventValue: safeLogClone(eventValue),
        resolved: resolved.map(item => ({
            status: item.status,
            attemptId: item.attempt?.id ?? null,
            memberName: item.attempt?.memberName ?? null,
        })),
    }, { force: true });

    return resolved;
}

function scheduleGenerationInterruptedCleanup(reason = 'generation_interrupted', eventValue = null) {
    if (!hasPendingTriggerWaiters()) {
        logVocaliaEvent('generation_lifecycle.cleanup_skipped', {
            reason,
            eventValue: safeLogClone(eventValue),
            cause: 'no_pending_waiters',
        });

        return;
    }

    const activeSnapshot = {
        avatar: vocaliaActiveGenerationTargetAvatar,
        name: vocaliaActiveGenerationTargetName,
        startedAt: vocaliaActiveGenerationTargetStartedAt,
        targetReason: vocaliaActiveGenerationTargetReason,
    };

    logVocaliaEvent('generation_lifecycle.cleanup_scheduled', {
        reason,
        eventValue: safeLogClone(eventValue),
        activeSnapshot,
        pendingTriggerWaiters: getPendingTriggerWaiterDebugSnapshot(),
    }, { force: true });

    setTimeout(() => {
        if (!hasPendingTriggerWaiters()) {
            logVocaliaEvent('generation_lifecycle.cleanup_cancelled', {
                reason,
                cause: 'waiters_already_resolved',
            });

            return;
        }

        resolvePendingTriggerWaitersAsInterrupted(reason, eventValue);
    }, 250);
}

function scheduleGenerationEndedTailChecks(reason = 'generation_ended_observed', eventValue = null) {
    const delays = [0, 250, 1000, 2500];

    for (const delay of delays) {
        setTimeout(() => {
            if (!hasPendingTriggerWaiters()) {
                logVocaliaEvent('generation_lifecycle.ended_tail_check_skipped', {
                    reason,
                    delay,
                    cause: 'no_pending_waiters',
                });
                return;
            }

            const resolved = resolvePendingTriggerWaitersFromExistingTail(`${reason}:tail_check:${delay}`);

            logVocaliaEvent('generation_lifecycle.ended_tail_check', {
                reason,
                delay,
                eventValue: safeLogClone(eventValue),
                resolvedCount: resolved.length,
                pendingTriggerWaiters: getPendingTriggerWaiterDebugSnapshot(),
                note: 'GENERATION_ENDED is observational only; pending waiters are not interrupted here.',
            });
        }, delay);
    }
}

function handleGenerationLifecycleStopped(eventValue) {
    scheduleGenerationInterruptedCleanup('generation_stopped_or_aborted', eventValue);
}

function handleGenerationLifecycleEnded(eventValue) {
    logVocaliaEvent('generation_lifecycle.ended_observed', {
        eventValue: safeLogClone(eventValue),
        pendingTriggerWaiters: getPendingTriggerWaiterDebugSnapshot(),
        activeTarget: {
            avatar: vocaliaActiveGenerationTargetAvatar,
            name: vocaliaActiveGenerationTargetName,
            startedAt: vocaliaActiveGenerationTargetStartedAt,
            reason: vocaliaActiveGenerationTargetReason,
        },
        note: 'GENERATION_ENDED is not treated as interruption. Waiting continues until MESSAGE_RECEIVED, timeout, explicit stop, or chat/group invalidation.',
    }, { force: true });

    scheduleGenerationEndedTailChecks('generation_ended_observed', eventValue);
}

function syncTriggeredThisTurnFromCounts(state = getChatState()) {
    const counts = normalizeParticipantResponseCounts(state.participantResponseCountsThisTurn ?? {});
    state.participantResponseCountsThisTurn = counts;
    state.triggeredThisTurn = Object.entries(counts)
        .filter(([_avatar, count]) => Number(count || 0) > 0)
        .map(([avatar]) => avatar);

    return state.triggeredThisTurn;
}

function resetTurnResponseTracking(state = getChatState()) {
    state.chainCount = 0;
    state.triggeredThisTurn = [];
    state.participantResponseCountsThisTurn = {};
}

function getParticipantResponseCountsThisTurn(state = getChatState()) {
    state.participantResponseCountsThisTurn = normalizeParticipantResponseCounts(state.participantResponseCountsThisTurn ?? {});
    return state.participantResponseCountsThisTurn;
}

function getTriggeredThisTurnSet() {
    return new Set(syncTriggeredThisTurnFromCounts(getChatState()));
}

function getParticipantResponseCount(memberOrAvatar, state = getChatState()) {
    const avatar = typeof memberOrAvatar === 'string' ? memberOrAvatar : memberOrAvatar?.avatar;
    if (!avatar) return 0;

    const counts = getParticipantResponseCountsThisTurn(state);
    return Number(counts[avatar] || 0);
}

function hasTriggeredThisTurn(member) {
    if (!member) return true;
    return getParticipantResponseCount(member) > 0;
}

function getTotalResponsesThisTurn(state = getChatState()) {
    const counts = getParticipantResponseCountsThisTurn(state);
    return Object.values(counts).reduce((sum, count) => sum + Number(count || 0), 0);
}

function getUniqueParticipantsThisTurn(state = getChatState()) {
    const counts = getParticipantResponseCountsThisTurn(state);
    return Object.values(counts).filter(count => Number(count || 0) > 0).length;
}

function getQueuedResponseCounts() {
    const queuedCounts = {};

    for (const item of triggerQueue) {
        const avatar = item?.member?.avatar;
        if (!avatar) continue;
        queuedCounts[avatar] = Number(queuedCounts[avatar] || 0) + 1;
    }

    return queuedCounts;
}

function getTurnLimitSettings() {
    const settings = getSettings();

    return {
        maxParticipantsPerTurn: clampInteger(settings.maxParticipantsPerTurn, 1, 10, DEFAULT_SETTINGS.maxParticipantsPerTurn),
        maxResponsesPerTurn: clampInteger(settings.maxResponsesPerTurn, 0, 50, DEFAULT_SETTINGS.maxResponsesPerTurn),
        maxResponsesPerParticipantPerTurn: clampInteger(settings.maxResponsesPerParticipantPerTurn, 1, 3, DEFAULT_SETTINGS.maxResponsesPerParticipantPerTurn),
    };
}

function markTriggeredThisTurn(member) {
    if (!member?.avatar) return;

    const state = getChatState();
    const counts = getParticipantResponseCountsThisTurn(state);

    counts[member.avatar] = Number(counts[member.avatar] || 0) + 1;

    state.participantResponseCountsThisTurn = counts;
    state.triggeredThisTurn = Object.entries(counts)
        .filter(([_avatar, count]) => Number(count || 0) > 0)
        .map(([avatar]) => avatar);

    state.chainCount = Object.values(counts).reduce((sum, count) => sum + Number(count || 0), 0);

    logVocaliaEvent('allowance.mark_spent', {
        member: memberDebugSummary(member),
        participantResponseCountsThisTurn: safeLogClone(state.participantResponseCountsThisTurn),
        triggeredThisTurn: arrayDebugNames(state.triggeredThisTurn),
        totalResponsesThisTurn: state.chainCount,
        uniqueParticipantsThisTurn: state.triggeredThisTurn.length,
    });
}

function unmarkTriggeredThisTurn(memberOrAvatar, reason = 'unspecified') {
    const state = getChatState();
    const avatar = typeof memberOrAvatar === 'string' ? memberOrAvatar : memberOrAvatar?.avatar;

    if (!avatar) return;

    const beforeCounts = safeLogClone(state.participantResponseCountsThisTurn ?? {});
    const counts = getParticipantResponseCountsThisTurn(state);
    const current = Number(counts[avatar] || 0);

    if (current > 1) {
        counts[avatar] = current - 1;
    } else {
        delete counts[avatar];
    }

    state.participantResponseCountsThisTurn = normalizeParticipantResponseCounts(counts);
    state.triggeredThisTurn = Object.keys(state.participantResponseCountsThisTurn);
    state.chainCount = Object.values(state.participantResponseCountsThisTurn)
        .reduce((sum, count) => sum + Number(count || 0), 0);

    logVocaliaEvent('allowance.mark_released', {
        avatar,
        name: avatarToDebugName(avatar),
        reason,
        beforeCounts,
        afterCounts: safeLogClone(state.participantResponseCountsThisTurn),
        triggeredThisTurn: arrayDebugNames(state.triggeredThisTurn),
    });
}

function isAlreadyQueuedThisTurn(member) {
    if (!member) return true;
    return triggerQueue.some(item => item?.member?.avatar === member.avatar);
}

function isRouteEligibleForQueue(member) {
    if (!member || member.disabled) return false;

    const state = ensureStateForCurrentGroup();

    if (typeof isAvatarRouteEligible === 'function') {
        return isAvatarRouteEligible(member.avatar, state);
    }

    if (typeof isAvatarActuallyPresent === 'function') {
        return isAvatarActuallyPresent(member.avatar, state);
    }

    return (
        (state.present ?? []).includes(member.avatar)
        && !(state.absent ?? []).includes(member.avatar)
        && !(state.pendingArrivals ?? []).includes(member.avatar)
    );
}

function filterTriggerAllowance(members) {
    const state = getChatState();
    const limits = getTurnLimitSettings();
    const evaluations = [];
    const accepted = [];

    const projectedCounts = {
        ...getParticipantResponseCountsThisTurn(state),
    };

    for (const [avatar, count] of Object.entries(getQueuedResponseCounts())) {
        projectedCounts[avatar] = Number(projectedCounts[avatar] || 0) + Number(count || 0);
    }

    const getProjectedTotal = () => Object.values(projectedCounts).reduce((sum, count) => sum + Number(count || 0), 0);
    const getProjectedUnique = () => Object.values(projectedCounts).filter(count => Number(count || 0) > 0).length;

    for (const member of uniqueMembers(members)) {
        const reasons = [];

        if (!member) {
            reasons.push('missing_member');
        } else {
            const currentCount = Number(projectedCounts[member.avatar] || 0);

            if (!isRouteEligibleForQueue(member)) {
                reasons.push('not_present_or_remote');
            }

            if (isAlreadyQueuedThisTurn(member)) {
                reasons.push('already_queued');
            }

            if (getProjectedTotal() >= limits.maxResponsesPerTurn) {
                reasons.push('max_responses_per_turn_reached');
            }

            if (currentCount <= 0 && getProjectedUnique() >= limits.maxParticipantsPerTurn) {
                reasons.push('max_participants_per_turn_reached');
            }

            if (currentCount >= limits.maxResponsesPerParticipantPerTurn) {
                reasons.push('max_responses_per_participant_per_turn_reached');
            }
        }

        const acceptedMember = !!member && reasons.length === 0;

        evaluations.push({
            member: memberDebugSummary(member),
            accepted: acceptedMember,
            reasons,
            projected: member ? {
                currentCount: Number(projectedCounts[member.avatar] || 0),
                totalResponses: getProjectedTotal(),
                uniqueParticipants: getProjectedUnique(),
            } : null,
        });

        if (!acceptedMember) continue;

        accepted.push(member);
        projectedCounts[member.avatar] = Number(projectedCounts[member.avatar] || 0) + 1;
    }

    logVocaliaEvent('allowance.filter', {
        incoming: members.map(memberDebugSummary),
        evaluations,
        allowed: accepted.map(memberDebugSummary),
        limits,
        actualCounts: safeLogClone(state.participantResponseCountsThisTurn ?? {}),
        projectedCounts,
    });

    return accepted;
}

function enqueueTriggers(members, sourceMessageId, reason = 'metadata') {
    const state = getChatState();
    const limits = getTurnLimitSettings();

    logVocaliaEvent('queue.enqueue.start', {
        sourceMessageId,
        reason,
        incomingMembers: members.map(memberDebugSummary),
        limits,
        currentCounts: safeLogClone(state.participantResponseCountsThisTurn ?? {}),
        currentChainCount: state.chainCount,
    });

    if (!members.length || limits.maxResponsesPerTurn <= 0) {
        logVocaliaEvent('queue.enqueue.refused', {
            sourceMessageId,
            reason,
            cause: !members.length ? 'no_members' : 'max_responses_per_turn_zero',
        });

        maybeApplyDeferredArrivalsAtChainEnd();
        return;
    }

    const allowed = filterTriggerAllowance(members);
    if (!allowed.length) {
        debugToast('No valid trigger targets remain for this user turn.');

        logVocaliaEvent('queue.enqueue.refused', {
            sourceMessageId,
            reason,
            cause: 'no_allowance_or_not_route_eligible',
        });

        maybeApplyDeferredArrivalsAtChainEnd();
        updateDiagnosticsPanel();
        return;
    }

    for (const member of allowed) {
        triggerQueue.push({
            member,
            sourceMessageId,
            reason,
            enqueuedAt: Date.now(),
        });
    }

    logVocaliaEvent('queue.enqueue.end', {
        sourceMessageId,
        reason,
        queued: allowed.map(memberDebugSummary),
    });

    updateDiagnosticsPanel();
    runTriggerQueue();
}

function maybeApplyDeferredArrivalsAtChainEnd() {
    const settings = getSettings();

    logVocaliaEvent('arrivals.deferred_check', {
        arrivalApplyMode: settings.arrivalApplyMode,
        queueLength: triggerQueue.length,
        queueRunning,
        pendingTriggerWaiters: getPendingTriggerWaiterDebugSnapshot(),
    });

    if (settings.arrivalApplyMode !== ARRIVAL_APPLY_DEFERRED) return [];
    if (triggerQueue.length || queueRunning || hasPendingTriggerWaiters()) return [];

    const applied = applyPendingArrivals();
    if (applied.length) {
        const names = applied.map(avatar => getChatState().members?.[avatar]?.name ?? avatar).join(', ');
        debugToast(`Applied pending arrivals: ${names}`);
        updateExtensionPrompt();
        updateDiagnosticsPanel();
        saveMetadata();
    }

    return applied;
}

async function runTriggerQueue() {
    if (queueRunning) {
        logVocaliaEvent('queue.run.skipped', {
            reason: 'already_running',
        });

        return;
    }

    queueRunning = true;

    logVocaliaEvent('queue.run.start', {
        queueLength: triggerQueue.length,
    });

    try {
        while (triggerQueue.length) {
            const settings = getSettings();

            if (!settings.enabled) {
                logVocaliaEvent('queue.run.aborted', {
                    reason: 'settings_disabled',
                    queueLength: triggerQueue.length,
                });

                triggerQueue = [];
                return;
            }

            const item = triggerQueue.shift();
            const state = ensureStateForCurrentGroup();

            logVocaliaEvent('queue.item.shifted', {
                item: {
                    sourceMessageId: item?.sourceMessageId,
                    reason: item?.reason,
                    member: memberDebugSummary(item?.member),
                },
                present: arrayDebugNames(state.present),
                remote: arrayDebugNames(state.remote),
                absent: arrayDebugNames(state.absent),
                pendingArrivals: arrayDebugNames(state.pendingArrivals),
                participantResponseCountsThisTurn: safeLogClone(state.participantResponseCountsThisTurn ?? {}),
            });

            if (!item?.member || !isRouteEligibleForQueue(item.member)) {
                logVocaliaEvent('queue.item.skipped', {
                    reason: !item?.member ? 'missing_member' : 'member_not_present_or_remote',
                    member: memberDebugSummary(item?.member),
                });

                continue;
            }

            const latestMember = getMemberByName(item.member.name, getGroupMembers());

            if (!latestMember || latestMember.disabled) {
                logVocaliaEvent('queue.item.skipped', {
                    reason: !latestMember ? 'latest_member_not_found' : 'latest_member_disabled',
                    originalMember: memberDebugSummary(item.member),
                    latestMember: memberDebugSummary(latestMember),
                });

                continue;
            }

            if (!isRouteEligibleForQueue(latestMember)) {
                logVocaliaEvent('queue.item.skipped', {
                    reason: 'latest_member_not_present_or_remote',
                    latestMember: memberDebugSummary(latestMember),
                });

                continue;
            }

            const allowedNow = filterTriggerAllowance([latestMember]);
            if (!allowedNow.length) {
                debugToast(`${latestMember.name} was skipped because they reached a Vocalia turn limit.`);

                logVocaliaEvent('queue.item.skipped', {
                    reason: 'turn_limit_reached',
                    latestMember: memberDebugSummary(latestMember),
                    limits: getTurnLimitSettings(),
                    counts: safeLogClone(getChatState().participantResponseCountsThisTurn ?? {}),
                });

                continue;
            }

            await sleep(Number(settings.triggerDelayMs) || 0);

            logVocaliaEvent('trigger.about_to_mark_and_call', {
                latestMember: memberDebugSummary(latestMember),
                reason: item.reason,
                sourceMessageId: item.sourceMessageId,
                triggerDelayMs: settings.triggerDelayMs,
                useSlashTrigger: settings.useSlashTrigger,
                fallbackToInternalGenerate: settings.fallbackToInternalGenerate,
                chatLengthBefore: ctx().chat?.length ?? null,
            });

            markTriggeredThisTurn(latestMember);
            await saveMetadata();
            updateDiagnosticsPanel();

            debugToast(`Triggering ${latestMember.name} (${item.reason})`);

            const attempt = recordTriggerAttemptStart(latestMember, {
                sourceMessageId: item.sourceMessageId,
                reason: item.reason,
                queueReason: item.reason,
            });

            setActiveGenerationTarget(latestMember, item.reason);

            try {
                logVocaliaEvent('trigger.call.start', {
                    latestMember: memberDebugSummary(latestMember),
                    reason: item.reason,
                    attemptId: attempt.id,
                });

                await triggerMember(latestMember);
                recordTriggerAttemptCommandReturned(attempt);

                logVocaliaEvent('trigger.call.returned_waiting_for_message', {
                    latestMember: memberDebugSummary(latestMember),
                    reason: item.reason,
                    attemptId: attempt.id,
                    timeoutMs: getTriggerMessageTimeoutMs(),
                });

                const waitResult = await waitForTriggeredAssistantMessage(
                    latestMember,
                    attempt,
                    getTriggerMessageTimeoutMs(),
                );

                logVocaliaEvent('trigger.message_wait.finished', {
                    latestMember: memberDebugSummary(latestMember),
                    attemptId: attempt.id,
                    status: waitResult.status,
                    messageId: waitResult.messageId ?? null,
                    message: waitResult.messageId != null ? getMessageDebugSummary(waitResult.messageId) : null,
                });

                if (waitResult.status === 'timeout') {
                    unmarkTriggeredThisTurn(latestMember, 'trigger_message_timeout');
                    triggerQueue = [];

                    globalThis.toastr?.warning(
                        `${latestMember.name} did not produce a message before Vocalia's trigger timeout. Queue stopped to avoid overlapping generations.`,
                        MODULE_DISPLAY_NAME,
                    );

                    logVocaliaEvent('queue.run.stopped_after_trigger_timeout', {
                        latestMember: memberDebugSummary(latestMember),
                        attemptId: attempt.id,
                    });

                    break;
                }

                if (waitResult.status === 'generation_interrupted') {
                    triggerQueue = [];

                    logVocaliaEvent('queue.run.stopped_after_generation_interrupted', {
                        latestMember: memberDebugSummary(latestMember),
                        attemptId: attempt.id,
                        reason: waitResult.reason ?? 'generation_interrupted',
                    }, { force: true });

                    break;
                }

                logVocaliaEvent('trigger.call.end', {
                    latestMember: memberDebugSummary(latestMember),
                    reason: item.reason,
                    attemptId: attempt.id,
                    waitStatus: waitResult.status,
                });
            } catch (triggerError) {
                recordTriggerAttemptFailure(attempt, triggerError);
                unmarkTriggeredThisTurn(latestMember, 'trigger_call_failed');

                throw triggerError;
            } finally {
                clearActiveGenerationTarget(`trigger_finished:${latestMember.name}`);
            }
        }
    } catch (error) {
        warn('Trigger queue failed.', error);
        errorToast(error?.message ?? error);

        logVocaliaEvent('queue.run.error', {
            error,
        });
    } finally {
        queueRunning = false;

        logVocaliaEvent('queue.run.end', {
            remainingQueueLength: triggerQueue.length,
        });

        maybeApplyDeferredArrivalsAtChainEnd();
        updateDiagnosticsPanel();
    }
}

// ============================================================================
// Section 16. SillyTavern Event Handlers and Send / Native Generation Guard
// ============================================================================
// Purpose:
// - React to user messages, assistant messages, renders, chat changes, and group changes.
// - Intercept empty Send in group chats so SillyTavern Manual mode cannot pick
//   a random unmuted group member.
// - Intercept Regenerate and Continue before native group generation can choose
//   an absent/random member.
// - Regenerate targets the current assistant tail message, never the prior user message.
// - Regenerate uses SillyTavern-style safe tail deletion with deleteLastMessage(),
//   never /cut.
// - Guard controlled generation sessions: after one accepted controlled response,
//   any extra native same-turn assistant message without a Vocalia waiter is refused
//   for routing/state changes, even if the message text is different.
// - Keep broad pointer/touch coverage for Regenerate / Continue controls.
// - Trigger Empty Send only from explicit send intent: Send button, send form, or
//   plain Enter inside the composer. Never trigger Empty Send from textbox focus/click.
// - Tag each message with witness metadata.
// - Filter prompt-building chat history per active target via generate_interceptor.
// - Treat native/bypass output as display-only when unsafe.
// - Derive assistantCountSinceUser from actual chat history instead of allowing
//   stale counters to accumulate across regenerate/delete cycles.
// ============================================================================

let vocaliaControlledGenerationSession = null;

const VOCALIA_CONTROLLED_GENERATION_GUARD_EVENTS = Object.freeze([
    'pointerdown',
    'mousedown',
    'mouseup',
    'click',
    'touchstart',
]);

const VOCALIA_EMPTY_SEND_BUTTON_SELECTORS = [
    '#send_but',
    '#send_button',
    '.send_but',
    '.send_button',
    '[data-i18n="[title]Send"]',
    '[data-i18n="Send"]',
    '[title="Send"]',
    '[title="Send message"]',
    '[aria-label="Send"]',
    '[aria-label="Send message"]',
].join(',');

function isMemberInRouteEligibleList(member, eligibleMembers = getRouteEligibleMembersCompat()) {
    return !!member && eligibleMembers.some(eligibleMember => eligibleMember.avatar === member.avatar);
}

function getCurrentComposerText() {
    const textarea = document.querySelector('#send_textarea');

    if (textarea && 'value' in textarea) {
        return String(textarea.value ?? '');
    }

    const editable = document.querySelector('[contenteditable="true"]#send_textarea, #send_textarea [contenteditable="true"]');
    if (editable) {
        return String(editable.textContent ?? '');
    }

    return '';
}

function getVocaliaMessageExtra(message, create = false) {
    if (!message) return null;

    if (create) {
        message.extra ??= {};
        message.extra[VOCALIA_EXTRA_KEY] ??= {};
    }

    return message.extra?.[VOCALIA_EXTRA_KEY] ?? null;
}

function getWitnessesFromMessage(message) {
    const extra = getVocaliaMessageExtra(message, false);
    const witnesses = extra?.[VOCALIA_WITNESSES_KEY];

    return Array.isArray(witnesses)
        ? [...new Set(witnesses.filter(Boolean))]
        : null;
}

function setWitnessesForMessage(messageId, witnesses, reason = 'unspecified') {
    const id = Number(messageId);
    const message = ctx().chat?.[id];

    if (!message) return [];

    const cleanWitnesses = [...new Set((witnesses ?? []).filter(Boolean))];
    const extra = getVocaliaMessageExtra(message, true);

    extra[VOCALIA_WITNESSES_KEY] = cleanWitnesses;

    logVocaliaEvent('witnesses.set', {
        messageId: id,
        reason,
        witnesses: arrayDebugNames(cleanWitnesses),
        message: getMessageDebugSummary(id),
    });

    return cleanWitnesses;
}

function getCurrentWitnessAvatarSet(additionalAvatars = []) {
    const witnesses = new Set();

    for (const member of getPresentMembers()) {
        if (!member.disabled) witnesses.add(member.avatar);
    }

    for (const member of getRemoteMembers()) {
        if (!member.disabled) witnesses.add(member.avatar);
    }

    for (const avatar of additionalAvatars) {
        if (avatar) witnesses.add(avatar);
    }

    return witnesses;
}

function getDirectUserMessageWitnessTargets(text) {
    const detection = detectUserSummonBootstrap(text);

    return detection.targets
        .filter(member => member && !member.disabled)
        .map(member => member.avatar);
}

function recordWitnessesForUserMessage(messageId, reason = 'user_message') {
    const message = ctx().chat?.[Number(messageId)];
    if (!message || !message.is_user || message.is_system) return [];

    const text = String(message.mes ?? '');
    const witnesses = getCurrentWitnessAvatarSet(getDirectUserMessageWitnessTargets(text));

    return setWitnessesForMessage(messageId, [...witnesses], reason);
}

function recordWitnessesForAssistantMessage(messageId, message, ownerBlock = null, ownerMember = null, reason = 'assistant_message') {
    if (!message || message.is_user || message.is_system) return [];

    const additional = [];
    const messageOwner = getMessageOwnerMember(message);

    if (messageOwner?.avatar) additional.push(messageOwner.avatar);
    if (ownerMember?.avatar) additional.push(ownerMember.avatar);

    if (ownerBlock?.name) {
        const blockOwner = getMemberByName(ownerBlock.name, getGroupMembers());
        if (blockOwner?.avatar) additional.push(blockOwner.avatar);
    }

    const witnesses = getCurrentWitnessAvatarSet(additional);
    return setWitnessesForMessage(messageId, [...witnesses], reason);
}

function shouldKeepMessageForWitnessTarget(message, targetAvatar) {
    if (!targetAvatar) return true;
    if (!message) return true;
    if (message.is_system) return true;

    const ownerMember = getMessageOwnerMember(message);
    if (ownerMember?.avatar === targetAvatar) return true;

    const witnesses = getWitnessesFromMessage(message);

    // Backward compatibility: old/untracked messages remain visible.
    if (!Array.isArray(witnesses)) return true;

    return witnesses.includes(targetAvatar);
}

function cloneMessageForPrompt(message) {
    return clone(message);
}

function resolveInterceptorTargetAvatar() {
    const activeMember = getActiveGenerationTargetMember();
    if (activeMember?.avatar) return activeMember.avatar;

    const context = ctx();
    const activeChidCandidates = [
        context.characterId,
        context.character_id,
        context.chid,
        context.selected_character,
        globalThis.characterId,
    ];

    for (const candidate of activeChidCandidates) {
        const chid = Number(candidate);
        if (!Number.isInteger(chid)) continue;

        const member = getGroupMembers().find(item => Number(item.chid) === chid);
        if (member?.avatar) return member.avatar;
    }

    return null;
}

async function aspectVocaliaGenerateInterceptor(chat, contextSize, abort, type) {
    const settings = getSettings();

    if (!settings.enabled || !settings.occludeUnwitnessedHistory) return;
    if (!ctx().groupId) return;
    if (!Array.isArray(chat) || !chat.length) return;

    const targetAvatar = resolveInterceptorTargetAvatar();

    if (!targetAvatar) {
        logVocaliaEvent('history_occlusion.skipped', {
            reason: 'no_generation_target_avatar',
            type,
            chatLength: chat.length,
            contextSize,
        });
        return;
    }

    const beforeLength = chat.length;
    const kept = [];
    const removed = [];

    for (let i = 0; i < chat.length; i += 1) {
        const message = chat[i];

        if (shouldKeepMessageForWitnessTarget(message, targetAvatar)) {
            kept.push(cloneMessageForPrompt(message));
        } else {
            removed.push({
                promptIndex: i,
                name: message?.name ?? null,
                is_user: !!message?.is_user,
                witnesses: getWitnessesFromMessage(message),
                mesPreview: String(message?.mes ?? '').slice(0, 200),
            });
        }
    }

    chat.splice(0, chat.length, ...kept);

    logVocaliaEvent('history_occlusion.applied', {
        type,
        contextSize,
        targetAvatar,
        targetName: avatarToDebugName(targetAvatar),
        beforeLength,
        afterLength: chat.length,
        removedCount: removed.length,
        removed,
    });
}

globalThis[VOCALIA_GENERATE_INTERCEPTOR_NAME] = aspectVocaliaGenerateInterceptor;

function createControlledGenerationSession(action, target, source) {
    const now = Date.now();

    vocaliaControlledGenerationSession = {
        id: `${action}:${target?.member?.avatar ?? 'unknown'}:${now}`,
        action,
        source,
        startedAtMs: now,
        startedAtIso: new Date(now).toISOString(),
        sourceMessageId: Number.isInteger(Number(target?.messageId)) ? Number(target.messageId) : null,
        targetMessageId: Number.isInteger(Number(target?.messageId)) ? Number(target.messageId) : null,
        targetAvatar: target?.member?.avatar ?? null,
        targetName: target?.member?.name ?? null,
        acceptedMessageIds: [],
        acceptedCount: 0,
        maxAcceptedMessages: 1,
        active: true,
    };

    logVocaliaEvent('controlled_generation.session.start', {
        session: safeLogClone(vocaliaControlledGenerationSession),
    }, { force: true });

    return vocaliaControlledGenerationSession;
}

function clearControlledGenerationSession(reason = 'unspecified') {
    if (!vocaliaControlledGenerationSession) return;

    logVocaliaEvent('controlled_generation.session.clear', {
        reason,
        session: safeLogClone(vocaliaControlledGenerationSession),
    }, { force: true });

    vocaliaControlledGenerationSession = null;
}

function isControlledGenerationSessionActive() {
    return !!(
        vocaliaControlledGenerationSession
        && vocaliaControlledGenerationSession.active
        && vocaliaControlledGenerationSession.targetAvatar
    );
}

function noteControlledGenerationAcceptedMessage(messageId, message, waiterResults = []) {
    if (!isControlledGenerationSessionActive()) return false;
    if (!waiterResults.length) return false;

    const matched = waiterResults.some(result => (
        result?.attempt?.memberAvatar === vocaliaControlledGenerationSession.targetAvatar
        && String(result?.attempt?.reason ?? '').startsWith(`controlled-${vocaliaControlledGenerationSession.action}`)
    ));

    if (!matched) return false;

    const id = Number(messageId);
    if (!vocaliaControlledGenerationSession.acceptedMessageIds.includes(id)) {
        vocaliaControlledGenerationSession.acceptedMessageIds.push(id);
    }

    vocaliaControlledGenerationSession.acceptedCount = vocaliaControlledGenerationSession.acceptedMessageIds.length;
    vocaliaControlledGenerationSession.lastAcceptedAtMs = Date.now();
    vocaliaControlledGenerationSession.lastAcceptedAtIso = new Date().toISOString();

    logVocaliaEvent('controlled_generation.session.accepted_message', {
        session: safeLogClone(vocaliaControlledGenerationSession),
        messageId: id,
        message: getMessageDebugSummary(id),
        waiterResults: waiterResults.map(result => ({
            status: result.status,
            attemptId: result.attempt?.id ?? null,
            memberName: result.attempt?.memberName ?? null,
            reason: result.attempt?.reason ?? null,
        })),
    }, { force: true });

    return true;
}

function shouldRefuseExtraControlledGenerationMessage(messageId, message, ownerBlock, ownerMember, waiterResults = []) {
    if (!isControlledGenerationSessionActive()) {
        return {
            refused: false,
            reason: 'no_active_controlled_generation_session',
        };
    }

    if (waiterResults.length) {
        return {
            refused: false,
            reason: 'message_matched_vocalia_waiter',
        };
    }

    if (!message || message.is_user || message.is_system) {
        return {
            refused: false,
            reason: 'not_assistant_message',
        };
    }

    if (vocaliaControlledGenerationSession.acceptedCount < vocaliaControlledGenerationSession.maxAcceptedMessages) {
        return {
            refused: false,
            reason: 'controlled_session_has_not_accepted_expected_message_yet',
        };
    }

    const id = Number(messageId);
    if (vocaliaControlledGenerationSession.acceptedMessageIds.includes(id)) {
        return {
            refused: false,
            reason: 'accepted_controlled_message',
        };
    }

    const messageOwner = getMessageOwnerMember(message);
    const sameTargetOwner = (
        messageOwner?.avatar === vocaliaControlledGenerationSession.targetAvatar
        || ownerMember?.avatar === vocaliaControlledGenerationSession.targetAvatar
    );

    return {
        refused: true,
        reason: sameTargetOwner
            ? 'native_extra_same_participant_after_controlled_generation'
            : 'native_extra_assistant_after_controlled_generation',
        session: safeLogClone(vocaliaControlledGenerationSession),
        messageOwner,
        ownerBlock,
        ownerMember,
        messageOwnerEligible: messageOwner ? isMemberRouteEligibleCompat(messageOwner) : false,
        structuredOwnerEligible: ownerMember ? isMemberRouteEligibleCompat(ownerMember) : false,
        ownerMismatch: !!messageOwner && !!ownerMember && messageOwner.avatar !== ownerMember.avatar,
    };
}

function getNoResponderBlockReason(text) {
    if (!getSettings().enabled) return null;
    if (!ctx().groupId) return null;

    const eligible = getRouteEligibleMembersCompat();
    if (eligible.length) return null;

    const summon = detectUserSummonBootstrap(text);
    if (summon.targets.length) return null;

    const departure = detectUserDepartureBootstrap(text);
    if (departure.departed.length) return null;

    return {
        reason: 'no_route_eligible_member_and_no_user_summon_or_departure',
        text,
    };
}

function stopNativeSendEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
}

function getClickableActionElement(element) {
    if (!(element instanceof Element)) return null;

    return element.closest([
        'button',
        '[role="button"]',
        'a',
        '.menu_button',
        '.mes_button',
        '.interactable',
        '.list-group-item',
        '.fa',
        '.fa-solid',
        '.fa-regular',
        '[title]',
        '[aria-label]',
        '[data-i18n]',
        '[data-action]',
        '[data-command]',
        '[data-name]',
        '[data-original-title]',
    ].join(','));
}

function getElementActionText(element) {
    if (!element) return '';

    const pieces = [];

    for (const attr of [
        'id',
        'class',
        'title',
        'aria-label',
        'data-i18n',
        'data-action',
        'data-command',
        'data-name',
        'data-original-title',
    ]) {
        const value = element.getAttribute?.(attr);
        if (value) pieces.push(value);
    }

    const text = String(element.textContent ?? '').trim();
    if (text && text.length <= 100) pieces.push(text);

    return pieces.join(' ').toLocaleLowerCase();
}

function detectControlledGenerationActionFromElement(element) {
    if (!element) return null;

    const parts = [];
    let current = element;

    while (current && current instanceof Element && parts.length < 6) {
        parts.push(getElementActionText(current));
        current = current.parentElement;
    }

    const haystack = parts.join(' ');

    if (/\b(regenerate|reroll|retry|redo|swipe)\b/i.test(haystack)) return 'regenerate';
    if (/\b(fa-rotate-right|fa-redo|fa-repeat|fa-sync|fa-arrows-rotate)\b/i.test(haystack)) return 'regenerate';

    if (/\b(continue|continue response|続きを生成|continuar|continuer)\b/i.test(haystack)) return 'continue';
    if (/\b(fa-forward|fa-forward-step|fa-play)\b/i.test(haystack) && /\bcontinue\b/i.test(haystack)) return 'continue';

    return null;
}

function getMessageIdFromDomElement(element) {
    const source = element instanceof Element ? element : null;
    if (!source) return null;

    const messageElement = source.closest('.mes, [mesid], [data-mes-id], [data-message-id], [data-messageid]');
    if (!messageElement) return null;

    const candidates = [
        messageElement.getAttribute('mesid'),
        messageElement.getAttribute('data-mes-id'),
        messageElement.getAttribute('data-message-id'),
        messageElement.getAttribute('data-messageid'),
    ];

    for (const candidate of candidates) {
        if (candidate == null) continue;
        const number = Number(candidate);
        if (Number.isInteger(number) && number >= 0) return number;
    }

    const id = String(messageElement.id ?? '');
    const idMatch = /(?:mes|message|chat)[^\d]*(\d+)/i.exec(id);

    if (idMatch) {
        const number = Number(idMatch[1]);
        if (Number.isInteger(number) && number >= 0) return number;
    }

    return null;
}

function findLastAssistantMessageId() {
    const chat = ctx().chat ?? [];

    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (!message || message.is_user || message.is_system) continue;
        if (isBlankAssistantMessage(message)) continue;
        return i;
    }

    return null;
}

function findLatestUserMessageBefore(messageId) {
    const chat = ctx().chat ?? [];
    const start = Math.min(Number(messageId) - 1, chat.length - 1);

    for (let i = start; i >= 0; i--) {
        const message = chat[i];
        if (!message || message.is_system) continue;

        if (message.is_user) {
            return {
                messageId: i,
                message,
                text: String(message.mes ?? ''),
            };
        }
    }

    return null;
}

function getMessageOwnerMember(message) {
    return getMemberByName(message?.name, getGroupMembers());
}

function getStructuredOwnerMemberFromMessage(message) {
    const blocks = parseStructuredMessage(message?.mes ?? '');
    const ownerBlock = firstValidOwnerBlock(blocks, message);
    const ownerMember = getMemberByName(ownerBlock?.name, getGroupMembers());

    return {
        blocks,
        ownerBlock,
        ownerMember,
    };
}

function resolveMessageTargetOwner(messageId) {
    const id = Number(messageId);
    const message = ctx().chat?.[id];

    if (!Number.isInteger(id) || !message || message.is_user || message.is_system) {
        return {
            messageId: Number.isInteger(id) ? id : null,
            message,
            member: null,
            source: 'missing_or_non_assistant_message',
            ownerBlock: null,
            messageOwner: null,
            structuredOwner: null,
        };
    }

    const messageOwner = getMessageOwnerMember(message);

    if (messageOwner && isMemberRouteEligibleCompat(messageOwner)) {
        return {
            messageId: id,
            message,
            member: messageOwner,
            source: 'message_owner',
            ownerBlock: null,
            messageOwner,
            structuredOwner: null,
        };
    }

    const { ownerBlock, ownerMember } = getStructuredOwnerMemberFromMessage(message);

    if (ownerMember && isMemberRouteEligibleCompat(ownerMember)) {
        return {
            messageId: id,
            message,
            member: ownerMember,
            source: 'structured_block_owner',
            ownerBlock,
            messageOwner,
            structuredOwner: ownerMember,
        };
    }

    return {
        messageId: id,
        message,
        member: null,
        source: 'no_route_eligible_message_or_structured_owner',
        ownerBlock,
        messageOwner,
        structuredOwner: ownerMember,
    };
}

function getTailRegenerateDeleteWindow() {
    const chat = ctx().chat ?? [];
    const end = chat.length - 1;
    const lastMessage = chat[end];

    if (!lastMessage || lastMessage.is_user || lastMessage.is_system) {
        return null;
    }

    const generationId = lastMessage.extra?.gen_id ?? null;
    let start = end;

    while (start >= 0) {
        const message = chat[start];
        if (!message) break;

        const messageGenerationId = message.extra?.gen_id ?? null;

        if ((generationId && messageGenerationId) && generationId !== messageGenerationId) {
            break;
        }

        if (message.is_user || message.is_system) {
            break;
        }

        start -= 1;
    }

    const safeStart = start + 1;

    return {
        start: safeStart,
        end,
        generationId,
        count: end - safeStart + 1,
    };
}

function isMessageIdInsideWindow(messageId, window) {
    const id = Number(messageId);

    return (
        window
        && Number.isInteger(id)
        && id >= window.start
        && id <= window.end
    );
}

function getControlledActionFallbackTarget(action, targetMessageId, rejectedMessageCandidate = null) {
    const state = ensureStateForCurrentGroup();

    if (state.waitingForUserByAvatar) {
        const waitingMember = getMemberByAvatar(state.waitingForUserByAvatar);

        if (waitingMember && isMemberRouteEligibleCompat(waitingMember)) {
            return {
                messageId: targetMessageId,
                message: ctx().chat?.[Number(targetMessageId)],
                member: waitingMember,
                source: 'waiting_for_user',
                reason: `controlled-${action}-waiting-for-user`,
                rejectedMessageCandidate,
            };
        }
    }

    if (state.lastSpeakerAvatar) {
        const lastSpeaker = getMemberByAvatar(state.lastSpeakerAvatar);

        if (lastSpeaker && isMemberRouteEligibleCompat(lastSpeaker)) {
            return {
                messageId: targetMessageId,
                message: ctx().chat?.[Number(targetMessageId)],
                member: lastSpeaker,
                source: 'last_speaker',
                reason: `controlled-${action}-last-speaker`,
                rejectedMessageCandidate,
            };
        }
    }

    const prior = findMostRecentRouteEligibleAssistantBefore(ctx().chat?.length ?? 0);

    if (prior?.member) {
        return {
            messageId: targetMessageId,
            message: ctx().chat?.[Number(targetMessageId)],
            member: prior.member,
            source: 'prior_route_eligible_assistant',
            reason: `controlled-${action}-prior-route-eligible-assistant`,
            rejectedMessageCandidate,
        };
    }

    const eligible = getRouteEligibleMembersCompat();

    if (eligible.length === 1) {
        return {
            messageId: targetMessageId,
            message: ctx().chat?.[Number(targetMessageId)],
            member: eligible[0],
            source: 'sole_route_eligible_member',
            reason: `controlled-${action}-sole-route-eligible-member`,
            rejectedMessageCandidate,
        };
    }

    return {
        messageId: targetMessageId,
        message: ctx().chat?.[Number(targetMessageId)],
        member: null,
        source: 'no_controlled_action_target',
        reason: `controlled-${action}-no-target`,
        rejectedMessageCandidate,
    };
}

function resolveRegenerateTargetFromCurrentAssistantTail(explicitMessageId) {
    const window = getTailRegenerateDeleteWindow();

    if (!window || window.count <= 0) {
        const fallbackId = findLastAssistantMessageId();
        const fallbackCandidate = Number.isInteger(Number(fallbackId))
            ? resolveMessageTargetOwner(Number(fallbackId))
            : null;

        return fallbackCandidate ?? {
            messageId: null,
            message: null,
            member: null,
            source: 'no_safe_tail_window',
            reason: 'controlled-regenerate-no-safe-tail-window',
            rejectedMessageCandidate: null,
        };
    }

    if (Number.isInteger(Number(explicitMessageId))) {
        const explicitId = Number(explicitMessageId);
        const explicitCandidate = resolveMessageTargetOwner(explicitId);

        if (isMessageIdInsideWindow(explicitId, window)) {
            if (explicitCandidate.member) {
                return {
                    ...explicitCandidate,
                    reason: `controlled-regenerate-${explicitCandidate.source}`,
                };
            }

            return getControlledActionFallbackTarget('regenerate', explicitId, explicitCandidate);
        }

        if (explicitCandidate.message && !explicitCandidate.message.is_user && !explicitCandidate.message.is_system) {
            return {
                ...explicitCandidate,
                reason: 'controlled-regenerate-explicit-message-outside-current-tail',
            };
        }
    }

    const tailMessageId = window.end;
    const tailCandidate = resolveMessageTargetOwner(tailMessageId);

    if (tailCandidate.member) {
        return {
            ...tailCandidate,
            reason: `controlled-regenerate-${tailCandidate.source}`,
        };
    }

    return getControlledActionFallbackTarget('regenerate', tailMessageId, tailCandidate);
}

function resolveContinueTarget(clickedElement) {
    const explicitMessageId = getMessageIdFromDomElement(clickedElement);
    const targetMessageId = Number.isInteger(Number(explicitMessageId))
        ? Number(explicitMessageId)
        : findLastAssistantMessageId();

    const candidate = Number.isInteger(Number(targetMessageId))
        ? resolveMessageTargetOwner(Number(targetMessageId))
        : null;

    if (candidate?.member) {
        return {
            ...candidate,
            reason: `controlled-continue-${candidate.source}`,
        };
    }

    return getControlledActionFallbackTarget('continue', targetMessageId, candidate);
}

function resolveControlledGenerationTarget(action, clickedElement) {
    const explicitMessageId = getMessageIdFromDomElement(clickedElement);

    if (action === 'regenerate') {
        return resolveRegenerateTargetFromCurrentAssistantTail(explicitMessageId);
    }

    return resolveContinueTarget(clickedElement);
}

async function deleteTailForVocaliaRegenerate(targetMessageId) {
    const chat = ctx().chat ?? [];
    const window = getTailRegenerateDeleteWindow();

    logVocaliaEvent('controlled_generation.tail_delete_window', {
        targetMessageId,
        window,
        chatLength: chat.length,
        targetMessage: Number.isInteger(Number(targetMessageId))
            ? getMessageDebugSummary(Number(targetMessageId))
            : null,
        tailMessage: chat.length ? getMessageDebugSummary(chat.length - 1) : null,
    }, { force: true });

    if (typeof importedDeleteLastMessage !== 'function') {
        globalThis.toastr?.error(
            'Vocalia regenerate refused: deleteLastMessage() is unavailable in this SillyTavern build.',
            MODULE_DISPLAY_NAME,
        );

        logVocaliaEvent('controlled_generation.tail_delete_refused', {
            reason: 'deleteLastMessage_unavailable',
            targetMessageId,
            window,
        }, { force: true });

        return false;
    }

    if (!window || window.count <= 0) {
        globalThis.toastr?.warning(
            'Vocalia regenerate refused: no safe assistant tail message found to replace.',
            MODULE_DISPLAY_NAME,
        );

        logVocaliaEvent('controlled_generation.tail_delete_refused', {
            reason: 'no_safe_tail_window',
            targetMessageId,
            window,
        }, { force: true });

        return false;
    }

    if (!isMessageIdInsideWindow(targetMessageId, window)) {
        globalThis.toastr?.warning(
            'Vocalia regenerate refused: target message is not in the current assistant tail. No messages were deleted.',
            MODULE_DISPLAY_NAME,
        );

        logVocaliaEvent('controlled_generation.tail_delete_refused', {
            reason: 'target_not_inside_tail_window',
            targetMessageId,
            window,
        }, { force: true });

        return false;
    }

    let deleted = 0;

    while (deleted < window.count) {
        const currentChat = ctx().chat ?? [];
        const currentLastId = currentChat.length - 1;
        const currentLastMessage = currentChat[currentLastId];

        if (currentLastId < window.start) break;

        if (!currentLastMessage || currentLastMessage.is_user || currentLastMessage.is_system) {
            logVocaliaEvent('controlled_generation.tail_delete_stopped', {
                reason: 'reached_user_or_system_or_missing_message',
                currentLastId,
                currentLastMessage: currentLastId >= 0 ? getMessageDebugSummary(currentLastId) : null,
                deleted,
                window,
            }, { force: true });

            break;
        }

        await importedDeleteLastMessage();
        deleted += 1;
    }

    logVocaliaEvent('controlled_generation.tail_delete_done', {
        targetMessageId,
        window,
        deleted,
        chatLengthAfter: ctx().chat?.length ?? null,
    }, { force: true });

    return deleted > 0;
}

async function handleVocaliaControlledGeneration(action, clickedElement, source = 'unknown') {
    if (vocaliaControlledGenerationInProgress) {
        logVocaliaEvent('controlled_generation.ignored', {
            action,
            source,
            reason: 'already_in_progress',
        }, { force: true });
        return;
    }

    if (hasPendingTriggerWaiters()) {
        logVocaliaEvent('controlled_generation.blocked_pending_waiter', {
            action,
            source,
            pendingTriggerWaiters: getPendingTriggerWaiterDebugSnapshot(),
        }, { force: true });

        return;
    }

    vocaliaControlledGenerationInProgress = true;

    try {
        const context = ctx();

        if (!getSettings().enabled || !context.groupId) {
            logVocaliaEvent('controlled_generation.ignored', {
                action,
                source,
                reason: !getSettings().enabled ? 'settings_disabled' : 'not_group_chat',
            });

            return;
        }

        ensureStateForCurrentGroup();
        await forceManualStrategyForCurrentGroup();

        const target = resolveControlledGenerationTarget(action, clickedElement);

        logVocaliaEvent('controlled_generation.target_resolved', {
            action,
            source,
            targetMessageId: target.messageId,
            targetMessage: Number.isInteger(Number(target.messageId)) ? getMessageDebugSummary(Number(target.messageId)) : null,
            targetMember: memberDebugSummary(target.member),
            targetSource: target.source,
            reason: target.reason,
            rejectedMessageCandidate: target.rejectedMessageCandidate ?? null,
        }, { force: true });

        if (!target.member || !isMemberRouteEligibleCompat(target.member)) {
            globalThis.toastr?.warning(
                `No eligible Vocalia ${action} speaker found.`,
                MODULE_DISPLAY_NAME,
            );

            await saveMetadata();
            updateDiagnosticsPanel();
            return;
        }

        const state = getChatState();
        resetTurnResponseTracking?.(state);
        state.chainCount = 0;
        state.activeTurnStartedAt = Date.now();
        state.triggeredThisTurn = [];
        state.participantResponseCountsThisTurn = {};
        triggerQueue = [];

        updateExtensionPrompt();
        updateDiagnosticsPanel();

        let sourceMessageId = Number.isInteger(Number(target.messageId))
            ? Number(target.messageId)
            : Math.max(0, (context.chat?.length ?? 1) - 1);

        if (action === 'regenerate') {
            const latestUser = findLatestUserMessageBefore(target.messageId);
            sourceMessageId = latestUser?.messageId ?? sourceMessageId;

            const deleteOk = await deleteTailForVocaliaRegenerate(target.messageId);
            if (!deleteOk) {
                clearControlledGenerationSession('controlled_regenerate_delete_refused');
                await saveMetadata();
                updateDiagnosticsPanel();
                return;
            }
        }

        createControlledGenerationSession(action, {
            ...target,
            messageId: sourceMessageId,
        }, source);

        enqueueTriggers([target.member], sourceMessageId, target.reason);

        await saveMetadata();
        updateDiagnosticsPanel();
    } catch (error) {
        clearControlledGenerationSession(`controlled_${action}_error`);
        warn(`Controlled ${action} failed.`, error);
        errorToast(`Vocalia ${action} failed: ${error?.message ?? error}`);

        logVocaliaEvent('controlled_generation.error', {
            action,
            source,
            error,
        }, { force: true });
    } finally {
        vocaliaControlledGenerationInProgress = false;
    }
}

function interceptControlledGenerationEvent(event, source) {
    if (!getSettings().enabled || !ctx().groupId) return false;

    const clickable = getClickableActionElement(event.target);
    const action = detectControlledGenerationActionFromElement(clickable);

    if (!action) return false;

    stopNativeSendEvent(event);

    logVocaliaEvent('controlled_generation.intercepted', {
        action,
        source,
        eventType: event.type,
        chatLength: ctx().chat?.length ?? null,
        clickedElementText: getElementActionText(clickable).slice(0, 500),
        clickedMessageId: getMessageIdFromDomElement(clickable),
    }, { force: true });

    void handleVocaliaControlledGeneration(action, clickable, source);

    return true;
}

function getSendButtonElement(element) {
    if (!(element instanceof Element)) return null;

    const directMatch = element.closest(VOCALIA_EMPTY_SEND_BUTTON_SELECTORS);
    if (directMatch) return directMatch;

    const clickable = getClickableActionElement(element);
    if (!clickable) return null;

    // Never classify the composer itself as a send control. Empty Send must be
    // deliberate send intent, not focus/click/pointer activity in the textbox.
    if (clickable.matches?.('#send_textarea') || clickable.closest?.('#send_textarea')) {
        return null;
    }

    const haystack = getElementActionText(clickable);

    if (/\b(send|send message|send_but|send-button)\b/i.test(haystack)) return clickable;
    if (/fa-paper-plane/i.test(haystack)) return clickable;

    return null;
}

function isSendButtonElement(element) {
    return !!getSendButtonElement(element);
}

function isComposerElement(element) {
    if (!(element instanceof Element)) return false;

    return (
        element.matches?.('#send_textarea')
        || !!element.closest?.('#send_textarea')
    );
}

function isPlainEnterSendIntent(event) {
    if (!event || event.key !== 'Enter') return false;
    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false;
    if (event.isComposing) return false;

    return true;
}

function isSendFormElement(element) {
    if (!(element instanceof Element)) return false;

    if (element.matches?.('#send_form, form') && element.querySelector?.('#send_textarea')) {
        return true;
    }

    return false;
}

async function handleVocaliaEmptySend(source = 'unknown') {
    if (vocaliaEmptySendInProgress) return;

    vocaliaEmptySendInProgress = true;

    try {
        if (hasPendingTriggerWaiters()) {
            globalThis.toastr?.warning(
                'A Vocalia-triggered reply is still pending. Wait for it to finish before continuing.',
                MODULE_DISPLAY_NAME,
            );

            logVocaliaEvent('empty_send.blocked_pending_waiter', {
                source,
                pendingTriggerWaiters: getPendingTriggerWaiterDebugSnapshot(),
            }, { force: true });

            return;
        }

        clearControlledGenerationSession('empty_send_new_continuation');

        ensureStateForCurrentGroup();
        await forceManualStrategyForCurrentGroup();

        const continuation = selectTargetsForEmptySendContinuation();

        logVocaliaEvent('empty_send.continuation_selected', {
            source,
            reason: continuation.reason,
            targets: continuation.targets.map(memberDebugSummary),
        }, { force: true });

        if (!continuation.targets.length) {
            globalThis.toastr?.warning(
                'No eligible Vocalia continuation speaker found.',
                MODULE_DISPLAY_NAME,
            );

            updateDiagnosticsPanel();
            await saveMetadata();
            return;
        }

        const state = getChatState();
        resetTurnResponseTracking?.(state);
        state.chainCount = 0;
        state.activeTurnStartedAt = Date.now();
        state.triggeredThisTurn = [];
        state.participantResponseCountsThisTurn = {};
        triggerQueue = [];

        enqueueTriggers(
            continuation.targets,
            state.lastUserMessageId ?? Math.max(0, (ctx().chat?.length ?? 1) - 1),
            continuation.reason,
        );

        await saveMetadata();
        updateDiagnosticsPanel();
    } catch (error) {
        warn('Empty-send continuation failed.', error);
        errorToast(`Vocalia continuation failed: ${error?.message ?? error}`);
    } finally {
        vocaliaEmptySendInProgress = false;
    }
}

function interceptEmptySendEvent(event, source, options = {}) {
    if (!getSettings().enabled || !ctx().groupId) return false;

    const composerText = getCurrentComposerText();

    if (!isBlankText(composerText)) return false;

    const hasExplicitSendIntent = !!(
        options.sendButton
        || options.formSubmit
        || options.composerEnter
    );

    if (!hasExplicitSendIntent) {
        logVocaliaEvent('empty_send.ignored_no_send_intent', {
            source,
            eventType: event?.type ?? null,
            targetText: event?.target instanceof Element ? getElementActionText(event.target).slice(0, 300) : null,
        });

        return false;
    }

    stopNativeSendEvent(event);
    void handleVocaliaEmptySend(source);

    return true;
}

function handleVocaliaControlledGenerationCapture(event) {
    interceptControlledGenerationEvent(event, `document_${event.type}_capture`);
}

function handleVocaliaSendButtonClickCapture(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const sendButton = getSendButtonElement(target);
    if (!sendButton) return;

    interceptEmptySendEvent(event, 'send_button_click', {
        sendButton,
    });
}

function handleVocaliaSendSubmitCapture(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!isSendFormElement(target)) return;

    interceptEmptySendEvent(event, 'send_form_submit', {
        formSubmit: target,
    });
}

function handleVocaliaComposerKeydownCapture(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!isComposerElement(target)) return;
    if (!isPlainEnterSendIntent(event)) return;

    interceptEmptySendEvent(event, 'composer_enter_key', {
        composerEnter: true,
    });
}

function installSendGuard() {
    if (vocaliaSendGuardInstalled) return;

    for (const eventName of VOCALIA_CONTROLLED_GENERATION_GUARD_EVENTS) {
        document.addEventListener(eventName, handleVocaliaControlledGenerationCapture, true);
    }

    document.addEventListener('click', handleVocaliaSendButtonClickCapture, true);
    document.addEventListener('submit', handleVocaliaSendSubmitCapture, true);
    document.addEventListener('keydown', handleVocaliaComposerKeydownCapture, true);

    vocaliaSendGuardInstalled = true;

    logVocaliaEvent('send_guard.installed', {
        installed: true,
        controlledGenerationEvents: [...VOCALIA_CONTROLLED_GENERATION_GUARD_EVENTS],
        emptySendEvents: ['click:send_button', 'submit:send_form', 'keydown:composer_enter'],
    });
}

function uninstallSendGuard() {
    if (!vocaliaSendGuardInstalled) return;

    for (const eventName of VOCALIA_CONTROLLED_GENERATION_GUARD_EVENTS) {
        document.removeEventListener(eventName, handleVocaliaControlledGenerationCapture, true);
    }

    document.removeEventListener('click', handleVocaliaSendButtonClickCapture, true);
    document.removeEventListener('submit', handleVocaliaSendSubmitCapture, true);
    document.removeEventListener('keydown', handleVocaliaComposerKeydownCapture, true);

    vocaliaSendGuardInstalled = false;
    vocaliaEmptySendInProgress = false;
    vocaliaControlledGenerationInProgress = false;

    logVocaliaEvent('send_guard.uninstalled', {
        installed: false,
        controlledGenerationEvents: [...VOCALIA_CONTROLLED_GENERATION_GUARD_EVENTS],
        emptySendEvents: ['click:send_button', 'submit:send_form', 'keydown:composer_enter'],
    });
}

async function handleUserMessage(eventValue) {
    const settings = getSettings();

    logVocaliaEvent('event.MESSAGE_SENT.received', {
        rawEventValue: eventValue,
        settingsEnabled: settings.enabled,
        groupId: ctx().groupId,
    });

    clearControlledGenerationSession('new_user_message');

    if (!settings.enabled) return;

    const context = ctx();
    if (!context.groupId) {
        logVocaliaEvent('event.MESSAGE_SENT.ignored', {
            reason: 'not_group_chat',
        });
        return;
    }

    const userMessageId = resolveMessageId(eventValue);
    const state = ensureStateForCurrentGroup();
    const userText = getMessageText(userMessageId);

    logVocaliaEvent('user_turn.start', {
        userMessageId,
        message: getMessageDebugSummary(userMessageId),
    });

    state.lastUserMessageId = userMessageId;
    state.assistantCountSinceUser = 0;
    state.chainCount = 0;
    state.activeTurnStartedAt = Date.now();
    state.pendingArrivals = [];
    state.triggeredThisTurn = [];
    state.participantResponseCountsThisTurn = {};
    triggerQueue = [];

    recordWitnessesForUserMessage(userMessageId, 'user_message_sent');

    await forceManualStrategyForCurrentGroup();
    updateExtensionPrompt();
    updateDiagnosticsPanel();

    applyUserDepartureBootstrap(userMessageId, userText);

    const assistantMessagesBefore = getAssistantMessagesBefore(userMessageId);
    const isOpeningUserMessage = assistantMessagesBefore.length === 0;

    logVocaliaEvent('user_turn.opening_check', {
        userMessageId,
        assistantMessagesBeforeCount: assistantMessagesBefore.length,
        isOpeningUserMessage,
    });

    if (isOpeningUserMessage) {
        const openingTargets = selectFirstSpeakerForOpeningUserMessage(userMessageId);

        logVocaliaEvent('user_turn.opening_targets', {
            userMessageId,
            openingTargets: openingTargets.map(memberDebugSummary),
        });

        if (openingTargets.length) {
            enqueueTriggers(openingTargets, userMessageId, 'opening-user-message');
        } else {
            debugToast('No first speaker selected for opening user message.');
        }
    } else {
        const continuation = selectContinuationTargetsForUserMessage(userMessageId, state);

        logVocaliaEvent('user_turn.continuation_targets', {
            userMessageId,
            reason: continuation.reason,
            targets: continuation.targets.map(memberDebugSummary),
        });

        if (continuation.targets.length) {
            enqueueTriggers(continuation.targets, userMessageId, continuation.reason);
        }
    }

    await saveMetadata();
    updateDiagnosticsPanel();

    logVocaliaEvent('user_turn.end', {
        userMessageId,
    });
}

function handleBlankAssistantMessage(messageId, message) {
    const correlatedAttempt = findRecentTriggerAttemptForMessage(message, messageId);

    logVocaliaEvent('assistant_message.blank_detected', {
        messageId,
        messageName: message?.name ?? null,
        message: getMessageDebugSummary(messageId),
        correlatedRecentVocaliaTriggerAttempt: correlatedAttempt,
        conclusion: correlatedAttempt
            ? 'Blank message may have resulted from a recent Vocalia trigger attempt.'
            : 'No recent Vocalia trigger attempt matched this blank message; likely native/manual/pending SillyTavern generation or an in-flight generation from before logging began.',
    });

    if (correlatedAttempt?.memberAvatar) {
        unmarkTriggeredThisTurn(correlatedAttempt.memberAvatar, 'blank_message_correlated_to_trigger_attempt');
        updateDiagnosticsPanel();
        saveMetadata();
    }
}

function shouldRefuseBypassRouting(message, ownerBlock, ownerMember, waiterResults = []) {
    if (waiterResults.length) {
        return {
            refused: false,
            reason: 'message_matched_vocalia_trigger_waiter',
            messageOwner: getMessageOwnerMember(message),
            ownerBlock,
            ownerMember,
            messageOwnerEligible: true,
            structuredOwnerEligible: true,
            ownerMismatch: false,
        };
    }

    const messageOwner = getMessageOwnerMember(message);
    const messageOwnerEligible = messageOwner ? isMemberRouteEligibleCompat(messageOwner) : false;
    const structuredOwnerEligible = ownerMember ? isMemberRouteEligibleCompat(ownerMember) : false;
    const ownerMismatch = !!messageOwner && !!ownerMember && messageOwner.avatar !== ownerMember.avatar;
    const absentMessageOwner = !!messageOwner && !messageOwnerEligible;

    if (absentMessageOwner) {
        return {
            refused: true,
            reason: 'native_or_bypass_absent_message_owner',
            messageOwner,
            ownerBlock,
            ownerMember,
            messageOwnerEligible,
            structuredOwnerEligible,
            ownerMismatch,
        };
    }

    if (ownerMismatch) {
        return {
            refused: true,
            reason: 'native_or_bypass_message_owner_mismatches_structured_owner',
            messageOwner,
            ownerBlock,
            ownerMember,
            messageOwnerEligible,
            structuredOwnerEligible,
            ownerMismatch,
        };
    }

    return {
        refused: false,
        reason: 'message_owner_route_eligible_or_no_mismatch',
        messageOwner,
        ownerBlock,
        ownerMember,
        messageOwnerEligible,
        structuredOwnerEligible,
        ownerMismatch,
    };
}

function warnBypassRoutingRefused(messageId, bypassDecision) {
    const now = Date.now();

    if (now - vocaliaBypassWarningLastShownAt > 5000) {
        vocaliaBypassWarningLastShownAt = now;

        globalThis.toastr?.warning(
            'Vocalia detected a native/bypass group generation and refused routing/state changes from it.',
            MODULE_DISPLAY_NAME,
        );
    }

    logVocaliaEvent('assistant_message.native_bypass_routing_refused', {
        messageId,
        reason: bypassDecision.reason,
        session: bypassDecision.session ?? null,
        messageOwner: memberDebugSummary(bypassDecision.messageOwner),
        ownerBlockName: bypassDecision.ownerBlock?.name ?? null,
        structuredOwner: memberDebugSummary(bypassDecision.ownerMember),
        messageOwnerEligible: bypassDecision.messageOwnerEligible,
        structuredOwnerEligible: bypassDecision.structuredOwnerEligible,
        ownerMismatch: bypassDecision.ownerMismatch,
        note: 'Visible overlay may render, but Vocalia state/routing transitions are refused. No auto-delete was performed.',
    }, { force: true });
}

async function handleMessageReceived(eventValue) {
    const settings = getSettings();

    logVocaliaEvent('event.MESSAGE_RECEIVED.received', {
        rawEventValue: eventValue,
        settingsEnabled: settings.enabled,
        groupId: ctx().groupId,
    });

    if (!settings.enabled) return;

    const context = ctx();
    if (!context.groupId) {
        logVocaliaEvent('event.MESSAGE_RECEIVED.ignored', {
            reason: 'not_group_chat',
        });
        return;
    }

    const messageId = resolveMessageId(eventValue);
    const message = context.chat?.[messageId];

    logVocaliaEvent('assistant_message.received', {
        messageId,
        message: getMessageDebugSummary(messageId),
    });

    if (!message || message.is_user || message.is_system) {
        logVocaliaEvent('assistant_message.ignored', {
            messageId,
            reason: !message ? 'missing_message' : message.is_user ? 'user_message' : 'system_message',
        });
        return;
    }

    const waiterResults = resolvePendingTriggerWaitersForMessage(messageId, message);

    if (isBlankAssistantMessage(message)) {
        handleBlankAssistantMessage(messageId, message);
        return;
    }

    const blocks = parseStructuredMessage(message.mes);

    logVocaliaEvent('assistant_message.parsed', {
        messageId,
        blockCount: blocks.length,
        blocks: blocks.map(block => ({
            name: block.name,
            routingMalformed: !!block.routingMalformed,
            malformedReasons: block.malformedReasons ?? [],
            participationNextTurn: block.participationNextTurn,
            speakingTo: block.speakingTo,
            arriving: block.arriving,
            remote: block.remote ?? [],
            parametersText: block.parametersText,
            parameterMeta: block.parameterMeta ?? null,
            segmentTypes: (block.segments ?? []).map(segment => segment.type),
            segmentRepairs: block.segmentRepairs ?? [],
        })),
    });

    if (!blocks.length) {
        recordWitnessesForAssistantMessage(messageId, message, null, null, 'assistant_message_unstructured');
        renderMessageOverlay(messageId);
        updateDiagnosticsPanel();
        await saveMetadata();
        return;
    }

    const assistantCountSinceUserBeforeMessage = Math.max(0, getAssistantCountSinceLatestUserFromChat(messageId) - 1);
    const firstAssistantForUserMessage = assistantCountSinceUserBeforeMessage === 0;
    const ownerBlock = firstValidOwnerBlock(blocks, message);
    const ownerMember = getMemberByName(ownerBlock?.name, getGroupMembers());

    recordWitnessesForAssistantMessage(messageId, message, ownerBlock, ownerMember, 'assistant_message_structured');

    logVocaliaEvent('assistant_message.owner_resolved', {
        messageId,
        messageName: message.name,
        assistantCountSinceUserBeforeMessage,
        firstAssistantForUserMessage,
        ownerBlock: ownerBlock ? {
            name: ownerBlock.name,
            routingMalformed: !!ownerBlock.routingMalformed,
            malformedReasons: ownerBlock.malformedReasons ?? [],
            participationNextTurn: ownerBlock.participationNextTurn,
            speakingTo: ownerBlock.speakingTo,
            arriving: ownerBlock.arriving,
            remote: ownerBlock.remote ?? [],
            segmentTypes: (ownerBlock.segments ?? []).map(segment => segment.type),
            segmentRepairs: ownerBlock.segmentRepairs ?? [],
        } : null,
        ownerMember: memberDebugSummary(ownerMember),
        waiterResults: waiterResults.map(result => ({
            status: result.status,
            attemptId: result.attempt?.id ?? null,
            memberName: result.attempt?.memberName ?? null,
            reason: result.attempt?.reason ?? null,
        })),
    });

    noteControlledGenerationAcceptedMessage(messageId, message, waiterResults);

    const extraControlledGenerationDecision = shouldRefuseExtraControlledGenerationMessage(
        messageId,
        message,
        ownerBlock,
        ownerMember,
        waiterResults,
    );

    if (extraControlledGenerationDecision.refused) {
        renderMessageOverlay(messageId);
        warnBypassRoutingRefused(messageId, extraControlledGenerationDecision);
        syncAssistantCountSinceUserFromChat(messageId, 'extra_controlled_generation_refused');
        updateDiagnosticsPanel();
        await saveMetadata();
        maybeApplyDeferredArrivalsAtChainEnd();
        return;
    }

    const bypassDecision = shouldRefuseBypassRouting(message, ownerBlock, ownerMember, waiterResults);

    if (bypassDecision.refused) {
        renderMessageOverlay(messageId);
        warnBypassRoutingRefused(messageId, bypassDecision);
        syncAssistantCountSinceUserFromChat(messageId, 'bypass_routing_refused');
        updateDiagnosticsPanel();
        await saveMetadata();
        maybeApplyDeferredArrivalsAtChainEnd();
        return;
    }

    const targets = applyOwnerBlockToState(ownerBlock, ownerMember, messageId, firstAssistantForUserMessage);

    updateExtensionPrompt();
    await saveMetadata();

    renderMessageOverlay(messageId);
    updateDiagnosticsPanel();

    logVocaliaEvent('assistant_message.routing_targets', {
        messageId,
        targets: targets.map(memberDebugSummary),
    });

    if (targets.length) {
        enqueueTriggers(targets, messageId, 'participation-next-turn');
    } else {
        maybeApplyDeferredArrivalsAtChainEnd();
    }
}

function handleMessageRendered(eventValue) {
    const messageId = resolveMessageId(eventValue);
    const message = ctx().chat?.[messageId];

    logVocaliaEvent('event.CHARACTER_MESSAGE_RENDERED', {
        rawEventValue: eventValue,
        messageId,
        message: getMessageDebugSummary(messageId),
    });

    if (message && isBlankAssistantMessage(message)) {
        logVocaliaEvent('event.CHARACTER_MESSAGE_RENDERED.blank', {
            messageId,
            messageName: message.name,
            correlatedRecentVocaliaTriggerAttempt: findRecentTriggerAttemptForMessage(message, messageId),
        });

        return;
    }

    if (Number.isInteger(messageId)) renderMessageOverlay(messageId);
}

async function handleChatChanged() {
    logVocaliaEvent('event.CHAT_CHANGED.received', {
        settingsEnabled: getSettings().enabled,
        groupId: ctx().groupId,
    });

    clearControlledGenerationSession('chat_changed');

    triggerQueue = [];
    queueRunning = false;

    if (!getSettings().enabled) return;

    ensureStateForCurrentGroup();
    syncAssistantCountSinceUserFromChat(null, 'chat_changed');

    await forceManualStrategyForCurrentGroup();
    updateExtensionPrompt();
    applyOverlaySettingToVisibleMessages();
    updateDiagnosticsPanel();
    await saveMetadata();

    logVocaliaEvent('event.CHAT_CHANGED.end');
}

async function handleGroupUpdated() {
    logVocaliaEvent('event.GROUP_UPDATED.received', {
        settingsEnabled: getSettings().enabled,
        groupId: ctx().groupId,
    });

    if (!getSettings().enabled) return;

    ensureStateForCurrentGroup();
    syncAssistantCountSinceUserFromChat(null, 'group_updated');

    await forceManualStrategyForCurrentGroup();
    updateExtensionPrompt();
    updateDiagnosticsPanel();
    await saveMetadata();

    logVocaliaEvent('event.GROUP_UPDATED.end');
}

// ============================================================================
// Section 17. Settings UI Constants, Help Text, and Styles
// ============================================================================
// Purpose:
// - Own drawer metadata, tooltip help text, and CSS injection.
// - Keep visual styling centralized.
// - Style section headers as full-width black bars.
// - Right-align number inputs.
// - Support viewport-constrained popups and tooltips.
// - Style semantic overlay nodes without using Markdown as the structure layer.
// ============================================================================

const VOCALIA_DEFAULT_MANIFEST_META = Object.freeze({
    version: '0.0.0',
    author: 'Genisai',
});

const VOCALIA_LABEL_HELP = Object.freeze({
    critical_controls: 'High-impact controls for turning Vocalia on, resetting current extension state, and opening diagnostics.',
    enabled: 'Turns Aspect: Vocalia on or off. When disabled, Vocalia stops injecting protocol instructions, routing speakers, intercepting native group generation, and rendering refined messages.',
    reset_extension: 'Restores Vocalia settings to defaults, clears Vocalia state for the current chat, stops active queues, clears active debug state, and resyncs the current group state.',

    runtime: 'Controls how Vocalia integrates with SillyTavern group generation and speaker routing.',
    auto_manual: 'Automatically changes the active group reply strategy to Manual while Vocalia is enabled, preventing native random group speaker selection.',
    restore_strategy: 'Restores the group reply strategy Vocalia found before it changed the group to Manual.',

    turn_flow: 'Controls how many group members may participate after one user message and how Vocalia selects first-turn speakers.',
    arrival_mode: 'Controls whether arriving characters become present immediately or after the current automatic response chain ends.',
    first_name_match: 'On the first user message of an empty chat, tries to trigger a present, remote, or locally summoned character by exact or unique name match.',
    first_fallback: 'Controls what Vocalia does on the first message when no character name match or summon is detected.',
    max_participants: 'Maximum number of unique assistant participants allowed after one user message.',
    max_responses: 'Maximum total assistant responses allowed after one user message.',
    max_responses_per_participant: 'Maximum number of times one specific character may respond after one user message.',
    response_delay: 'Delay, in seconds, before Vocalia triggers the next queued assistant response.',

    refined_display: 'Controls how structured Vocalia messages are rendered as readable roleplay text in the chat UI.',
    render_overlay: 'Displays the raw structured message as a refined readable message without changing the stored chat text.',
    hide_empty_blocks: 'Hides empty structured block placeholders in refined messages.',
    hide_character_name: 'Hides the active character label in refined messages.',
    hide_thoughts: 'Hides private [thoughts] segments in refined messages.',
    quote_dialogue: 'Wraps dialogue in quotes when displaying refined messages.',
    action_style: 'Visual style applied to [actions] segments.',
    narration_style: 'Visual style applied to [narration] segments.',
    thoughts_style: 'Visual style applied to [thoughts] segments.',

    protocol: 'Controls the Vocalia protocol prompt and diagnostic toast behavior.',
    prompt_depth: 'Depth where Vocalia protocol instructions are injected into the prompt.',
    hide_debug_toasts: 'Suppresses non-critical Vocalia debug toasts.',

    memory: 'Controls what conversation history a character can recall based on whether they were present or remotely connected when messages occurred.',
    recall_presence: 'When enabled, Vocalia filters prompt history so a character only recalls messages they witnessed while present or remotely connected.',

    status_section: 'Opens scene status diagnostics. Present means physically in-scene. Remote means active phone, radio, video, or text contact. Absent means neither present nor remotely connected.',
    status_popup: 'Shows current scene arrays and lets you manually adjust each group member’s Vocalia status for testing or correction.',
    status_arrays: 'Current Vocalia scene arrays for the active group chat.',
    status_member_table: 'Lists every participant, whether they are enabled in the group, their response count this turn, and their current Vocalia status.',
    sync_state: 'Rebuilds Vocalia scene state from the active group roster. Useful after changing group members or recovering from mismatched diagnostics.',

    debug_popup: 'Collects a focused diagnostic trace. Start logging, reproduce the issue, then copy or download the log.',
    debug_status: 'Shows whether debug logging is active, how many entries are buffered, and the start/stop timestamps.',
    debug_log_controls: 'Start, stop, copy, download, or clear the current debug trace.',
    dump_state: 'Prints Vocalia settings, chat state, and debug bundle to the browser console.',

    utilities: 'Small one-off tools for refreshing Vocalia display behavior.',
    render_now: 'Reapplies the current refined-message display setting to visible messages.',
});

let vocaliaManifestMeta = { ...VOCALIA_DEFAULT_MANIFEST_META };

function injectStyles() {
    if (styleElement) return;

    styleElement = document.createElement('style');
    styleElement.id = 'aspect_vocalia_styles';
    styleElement.textContent = `
        #aspect_vocalia_settings small { opacity: 0.8; line-height: 1.35; }

        #aspect_vocalia_settings input[type="number"] {
            max-width: 8em;
            text-align: right;
        }

        #aspect_vocalia_settings select { max-width: 18em; }

        #aspect_vocalia_settings .checkbox_label {
            align-items: flex-start;
            line-height: 1.2;
        }

        #aspect_vocalia_settings .checkbox_label input[type="checkbox"] {
            margin-top: 0.12em;
            flex: 0 0 auto;
        }

        #aspect_vocalia_settings .aspect-vocalia-settings-box {
            border: 1px solid #000;
            border-radius: 10px;
            padding: 10px;
            margin: 8px 0;
        }

        #aspect_vocalia_settings .aspect-vocalia-settings-tagline {
            font: inherit;
            font-size: 0.9em;
            opacity: 0.75;
            text-align: right;
            margin: 0 0 8px;
        }

        #aspect_vocalia_settings .aspect-vocalia-settings-section {
            position: relative;
            padding: 12px 0 10px;
            border-top: none;
        }

        #aspect_vocalia_settings .aspect-vocalia-settings-section:first-of-type {
            padding-top: 0;
        }

        #aspect_vocalia_settings .aspect-vocalia-section-title,
        #aspect_vocalia_settings .aspect-vocalia-label,
        #aspect_vocalia_settings .aspect-vocalia-popup-title {
            font-weight: 600;
            font-size: 0.95rem;
            opacity: 0.95;
            line-height: 1.25;
        }

        #aspect_vocalia_settings .aspect-vocalia-section-title {
            display: block;
            box-sizing: border-box;
            width: 100%;
            font-weight: 700;
            margin: 0 0 10px;
            padding: 6px 10px;
            border: 0;
            border-radius: 4px;
            background: #000;
            color: #fff;
            box-shadow: none;
            letter-spacing: 0.01em;
            opacity: 1;
        }

        #aspect_vocalia_settings .aspect-vocalia-popup-title {
            display: inline-block;
        }

        #aspect_vocalia_settings .aspect-vocalia-section-title .aspect-vocalia-info-trigger-text {
            border-color: rgba(255,255,255,0.85);
            background: #fff;
            color: #111111;
        }

        #aspect_vocalia_settings .aspect-vocalia-label,
        #aspect_vocalia_settings .aspect-vocalia-label-text {
            display: inline;
            line-height: 1.25;
            cursor: pointer;
        }

        #aspect_vocalia_settings .aspect-vocalia-critical-box {
            border: 1px solid rgba(183, 110, 121, 0.65);
            outline: 1px solid rgba(183, 110, 121, 0.65);
            outline-offset: 2px;
            border-radius: 12px;
            padding: 10px;
            margin: 10px 0 14px;
            background: var(--SmartThemeBlurTintColor, rgba(0,0,0,0.08));
        }

        #aspect_vocalia_settings .aspect-vocalia-critical-enable-row,
        #aspect_vocalia_settings .aspect-vocalia-critical-button-row,
        #aspect_vocalia_settings .aspect-vocalia-button-row {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 8px;
        }

        #aspect_vocalia_settings .aspect-vocalia-critical-enable-row {
            align-items: flex-start;
            margin-bottom: 10px;
        }

        #aspect_vocalia_settings .aspect-vocalia-inline-unit {
            opacity: 0.85;
            margin-left: 0.35em;
            white-space: nowrap;
        }

        #aspect_vocalia_settings .aspect-vocalia-control-with-tip {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            flex: 0 0 auto;
        }

        #aspect_vocalia_settings button,
        #aspect_vocalia_settings input[type="button"] {
            width: auto;
            min-width: max-content;
            white-space: nowrap;
        }

        #aspect_vocalia_settings .aspect-vocalia-popup-wrap {
            position: relative;
            display: inline-flex;
        }

        #aspect_vocalia_settings .aspect-vocalia-popup-button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            white-space: nowrap;
            width: auto;
            min-width: max-content;
            flex: 0 0 auto;
        }

        #aspect_vocalia_settings .aspect-vocalia-popup {
            display: none;
            position: absolute;
            left: 0;
            top: calc(100% + 4px);
            z-index: 10000;
            box-sizing: border-box;
            padding: 10px;
            border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.25));
            border-radius: 8px;
            background: var(--SmartThemeBlurTintColor, var(--SmartThemeBodyColor, #1e1e1e));
            box-shadow: 0 4px 12px rgba(0,0,0,0.35);
        }

        #aspect_vocalia_settings .aspect-vocalia-popup.aspect-vocalia-popup-open {
            position: fixed;
            left: var(--aspect-vocalia-popup-left, 8px);
            top: var(--aspect-vocalia-popup-top, 8px);
            display: flex;
            flex-direction: column;
            gap: 8px;
            width: min(680px, calc(100vw - 16px));
            max-height: calc(100vh - 16px);
            overflow: auto;
        }

        #aspect_vocalia_debug_popup.aspect-vocalia-popup-open {
            width: min(520px, calc(100vw - 16px));
        }

        #aspect_vocalia_protocol_popup.aspect-vocalia-popup-open {
            width: min(760px, calc(100vw - 16px));
        }

        #aspect_vocalia_protocol_popup .aspect-vocalia-protocol-field {
            display: flex;
            flex-direction: column;
            gap: 4px;
            padding: 8px;
            border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.18));
            border-radius: 8px;
        }

        #aspect_vocalia_protocol_popup .aspect-vocalia-protocol-field-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
        }

        #aspect_vocalia_protocol_popup .aspect-vocalia-protocol-textarea {
            box-sizing: border-box;
            width: 100%;
            min-height: 4em;
            resize: vertical;
            font-family: var(--monoFontFamily, monospace);
            font-size: 0.85em;
            line-height: 1.35;
            white-space: pre;
        }

        #aspect_vocalia_protocol_popup .aspect-vocalia-protocol-preview {
            opacity: 0.75;
            font-size: 0.85em;
            white-space: pre-wrap;
            word-break: break-word;
        }

        #aspect_vocalia_member_state_table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 0.5em;
        }

        #aspect_vocalia_member_state_table th,
        #aspect_vocalia_member_state_table td {
            padding: 0.35em 0.45em;
            border-bottom: 1px solid var(--SmartThemeBorderColor);
            vertical-align: middle;
        }

        #aspect_vocalia_member_state_table th {
            text-align: left;
            opacity: 0.85;
            font-weight: 600;
        }

        #aspect_vocalia_member_state_table .aspect-vocalia-member-name { font-weight: 600; }
        #aspect_vocalia_member_state_table .aspect-vocalia-member-avatar {
            opacity: 0.7;
            font-size: 0.85em;
            word-break: break-all;
        }

        .aspect-vocalia-array-list {
            display: grid;
            gap: 0.25em;
            margin: 0.5em 0;
            font-size: 0.9em;
        }

        .aspect-vocalia-array-list code,
        .aspect-vocalia-debug-status code {
            white-space: normal;
            word-break: break-word;
        }

        .aspect-vocalia-debug-status {
            display: grid;
            gap: 0.25em;
            padding: 0.5em;
            border: 1px solid var(--SmartThemeBorderColor);
            border-radius: 6px;
            opacity: 0.95;
        }

        #aspect_vocalia_settings .aspect-vocalia-footer-divider {
            border-top: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15));
            margin-top: 10px;
            padding-top: 8px;
        }

        #aspect_vocalia_settings .aspect-vocalia-settings-footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            opacity: 0.75;
            font-size: 0.9em;
        }

        #aspect_vocalia_settings #aspect_vocalia_settings_author {
            text-align: right;
            margin-left: auto;
        }

        #aspect_vocalia_settings .aspect-vocalia-info-tooltip {
            position: relative;
            display: inline-flex;
            align-items: center;
            margin-left: 0.22em;
            isolation: isolate;
            transform: translateY(-0.12em);
            z-index: 1;
            white-space: nowrap;
            vertical-align: text-top;
        }

        #aspect_vocalia_settings .aspect-vocalia-info-trigger {
            border: 0;
            background: transparent;
            color: #111111;
            cursor: help;
            font-family: "Trebuchet MS", Verdana, sans-serif;
            font-size: 0.52rem;
            font-weight: 700;
            line-height: 1;
            padding: 2px;
            opacity: 0.96;
            transform: translateY(-0.04em);
        }

        #aspect_vocalia_settings .aspect-vocalia-info-trigger-text {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 0.58rem;
            height: 0.58rem;
            border-radius: 999px;
            border: 1px solid color-mix(in srgb, #ffffff 78%, var(--SmartThemeBorderColor) 22%);
            background: color-mix(in srgb, #ffffff 92%, var(--SmartThemeBlurTintColor, rgba(255,255,255,0.03)) 8%);
            color: #111111;
            font: inherit;
            line-height: 1;
            box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.2);
            padding-top: 0.08em;
        }

        .aspect-vocalia-tooltip-layer {
            position: fixed;
            inset: 0;
            pointer-events: none;
            z-index: 2147483646;
        }

        #aspect_vocalia_settings .aspect-vocalia-info-bubble,
        .aspect-vocalia-tooltip-layer .aspect-vocalia-info-bubble {
            --aspect-vocalia-tooltip-left: 12px;
            --aspect-vocalia-tooltip-top: 12px;
            position: fixed;
            top: var(--aspect-vocalia-tooltip-top);
            left: var(--aspect-vocalia-tooltip-left);
            width: min(320px, calc(100vw - 24px));
            max-width: calc(100vw - 24px);
            padding: 10px 12px;
            border-radius: 10px;
            border: 1px solid var(--SmartThemeBorderColor);
            background: var(--SmartThemeBlurTintColor, rgba(28, 28, 28, 1));
            box-shadow: 0 12px 32px rgba(0, 0, 0, 0.30);
            color: var(--SmartThemeBodyColor);
            font-size: 0.78rem;
            font-weight: 400;
            line-height: 1.35;
            opacity: 0;
            visibility: hidden;
            pointer-events: none;
            transform: translate3d(0, -4px, 0);
            transition: opacity 120ms ease, transform 120ms ease;
            z-index: 2147483647;
        }

        .aspect-vocalia-tooltip-layer .aspect-vocalia-info-bubble.is-measuring {
            display: block;
            visibility: hidden;
        }

        .aspect-vocalia-tooltip-layer .aspect-vocalia-info-bubble.is-active.is-positioned {
            opacity: 1;
            visibility: visible;
            pointer-events: auto;
            transform: translate3d(0, 0, 0);
        }

        #chat .mes[data-aspect-vocalia-rendered="true"] .mes_text { display: block; }

        .aspect-vocalia-block {
            display: flex;
            flex-direction: column;
            gap: 0.45em;
        }

        .aspect-vocalia-block + .aspect-vocalia-block { margin-top: 0.75em; }
        .aspect-vocalia-character-label { font-weight: 700; }
        .aspect-vocalia-segment { white-space: pre-wrap; }
        .aspect-vocalia-segment-dialogue { font-style: normal; }

        .aspect-vocalia-segment[data-display-style="${OVERLAY_STYLE_ITALIC}"] { font-style: italic; }
        .aspect-vocalia-segment[data-display-style="${OVERLAY_STYLE_BOLD}"] { font-weight: 700; }
        .aspect-vocalia-segment[data-display-style="${OVERLAY_STYLE_BOLD_ITALIC}"] { font-weight: 700; font-style: italic; }
        .aspect-vocalia-segment[data-display-style="${OVERLAY_STYLE_UNDERLINE}"] { text-decoration: underline; }
        .aspect-vocalia-segment[data-display-style="${OVERLAY_STYLE_STRIKE}"] { text-decoration: line-through; }
        .aspect-vocalia-segment[data-display-style="${OVERLAY_STYLE_UPPERCASE}"] { text-transform: uppercase; }
        .aspect-vocalia-segment[data-display-style="${OVERLAY_STYLE_LOWERCASE}"] { text-transform: lowercase; }

        .aspect-vocalia-segment[data-display-style="muted"],
        .aspect-vocalia-segment[data-display-style="${OVERLAY_STYLE_ASTERISKS}"],
        .aspect-vocalia-segment[data-display-style="muted_bold"],
        .aspect-vocalia-segment[data-display-style="muted_underline"],
        .aspect-vocalia-segment[data-display-style="muted_strike"],
        .aspect-vocalia-segment[data-display-style="muted_uppercase"],
        .aspect-vocalia-segment[data-display-style="muted_lowercase"] {
            opacity: 0.88;
        }

        .aspect-vocalia-segment[data-display-style="muted_bold"] { font-weight: 700; }
        .aspect-vocalia-segment[data-display-style="muted_underline"] { text-decoration: underline; }
        .aspect-vocalia-segment[data-display-style="muted_strike"] { text-decoration: line-through; }
        .aspect-vocalia-segment[data-display-style="muted_uppercase"] { text-transform: uppercase; }
        .aspect-vocalia-segment[data-display-style="muted_lowercase"] { text-transform: lowercase; }

        .aspect-vocalia-segment-thoughts { opacity: 0.92; }

        .aspect-vocalia-segment-thoughts[data-display-style="muted"],
        .aspect-vocalia-segment-thoughts[data-display-style="${OVERLAY_STYLE_ASTERISKS}"],
        .aspect-vocalia-segment-thoughts[data-display-style="muted_bold"],
        .aspect-vocalia-segment-thoughts[data-display-style="muted_underline"],
        .aspect-vocalia-segment-thoughts[data-display-style="muted_strike"],
        .aspect-vocalia-segment-thoughts[data-display-style="muted_uppercase"],
        .aspect-vocalia-segment-thoughts[data-display-style="muted_lowercase"] {
            opacity: 0.78;
        }

        .aspect-vocalia-formatted,
        .aspect-vocalia-formatted p {
            display: inline;
            margin: 0;
            padding: 0;
        }

        .aspect-vocalia-formatted > :first-child,
        .aspect-vocalia-formatted p:first-child { margin-top: 0; }

        .aspect-vocalia-formatted > :last-child,
        .aspect-vocalia-formatted p:last-child { margin-bottom: 0; }
    `;

    document.head.appendChild(styleElement);
}

// ============================================================================
// Section 18. Settings UI Manifest, Protocol Editor, and Tooltips
// ============================================================================
// Purpose:
// - Load manifest metadata for the drawer footer.
// - Render editable protocol-injection fields.
// - Shield editable popup fields from global keyboard/clipboard handlers.
// - Provide reference-style viewport-constrained info tooltips.
// ============================================================================

function getManifestAuthorName(author) {
    if (typeof author === 'string') return author;

    if (Array.isArray(author)) {
        return author
            .map(entry => getManifestAuthorName(entry))
            .filter(Boolean)
            .join(', ');
    }

    if (author && typeof author === 'object') {
        return String(author.name || author.author || author.display_name || '').trim();
    }

    return '';
}

async function loadVocaliaManifestMetadata() {
    try {
        const manifestUrl = new URL('./manifest.json', import.meta.url);
        const response = await fetch(manifestUrl);

        if (!response.ok) {
            throw new Error(`Manifest request failed: ${response.status}`);
        }

        const manifest = await response.json();
        const version = String(manifest.version || VOCALIA_DEFAULT_MANIFEST_META.version).trim();
        const author = getManifestAuthorName(manifest.author).trim() || VOCALIA_DEFAULT_MANIFEST_META.author;

        vocaliaManifestMeta = { version, author };
        renderVocaliaSettingsFooter();
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to load manifest metadata:`, error);

        vocaliaManifestMeta = { ...VOCALIA_DEFAULT_MANIFEST_META };
        renderVocaliaSettingsFooter();
    }
}

function renderVocaliaSettingsFooter() {
    $('#aspect_vocalia_settings_version').text(`Version ${vocaliaManifestMeta.version}`);
    $('#aspect_vocalia_settings_author').text(vocaliaManifestMeta.author);
}

function cssEscape(value) {
    if (globalThis.CSS?.escape) return CSS.escape(String(value));
    return String(value).replace(/["\\]/g, '\\$&');
}

function isVocaliaEditableElement(element) {
    if (!element) return false;

    return !!element.closest?.(
        'textarea, input, select, [contenteditable="true"], [contenteditable="plaintext-only"]',
    );
}

function shieldVocaliaPopupEditableEvents(rootElement) {
    if (!rootElement || rootElement.dataset.editableEventShieldBound === 'true') return;

    const shield = event => {
        if (!isVocaliaEditableElement(event.target)) return;
        event.stopPropagation();
    };

    for (const eventName of ['keydown', 'keyup', 'keypress', 'copy', 'cut', 'paste', 'selectstart']) {
        rootElement.addEventListener(eventName, shield, true);
        rootElement.addEventListener(eventName, shield, false);
    }

    rootElement.dataset.editableEventShieldBound = 'true';
}

function renderProtocolInjectionEditorFields() {
    if (typeof getProtocolInstructionSectionDefinitions !== 'function') return '';

    return getProtocolInstructionSectionDefinitions().map(definition => {
        const key = escapeHtml(definition.key);
        const label = escapeHtml(definition.label);
        const value = escapeHtml(getProtocolInstructionTemplate(definition.key));
        const rows = Math.max(2, Math.min(14, Number(definition.rows) || 5));
        const preview = escapeHtml(getProtocolInstructionPreviewText(definition.key));

        return `
            <div class="aspect-vocalia-protocol-field" data-protocol-key="${key}">
                <div class="aspect-vocalia-protocol-field-header">
                    <label for="aspect_vocalia_protocol_${key}" class="aspect-vocalia-label">${label}</label>
                    <button
                        type="button"
                        class="menu_button aspect-vocalia-protocol-reset"
                        data-protocol-key="${key}"
                    >Reset</button>
                </div>
                <textarea
                    id="aspect_vocalia_protocol_${key}"
                    class="text_pole aspect-vocalia-protocol-textarea"
                    data-protocol-key="${key}"
                    rows="${rows}"
                    spellcheck="false"
                >${value}</textarea>
                <div class="aspect-vocalia-protocol-preview" data-protocol-preview="${key}">${preview}</div>
            </div>`;
    }).join('');
}

function updateProtocolInjectionPreview(key) {
    if (!key || typeof getProtocolInstructionPreviewText !== 'function') return;

    const preview = document.querySelector(`#aspect_vocalia_protocol_popup [data-protocol-preview="${cssEscape(key)}"]`);
    if (!preview) return;

    preview.textContent = getProtocolInstructionPreviewText(key);
}

function updateAllProtocolInjectionPreviews() {
    if (typeof getProtocolInstructionSectionDefinitions !== 'function') return;

    for (const definition of getProtocolInstructionSectionDefinitions()) {
        updateProtocolInjectionPreview(definition.key);
    }
}

function loadProtocolInjectionEditorUi() {
    if (typeof getProtocolInstructionSectionDefinitions !== 'function') return;

    for (const definition of getProtocolInstructionSectionDefinitions()) {
        const textarea = document.querySelector(`#aspect_vocalia_protocol_popup textarea[data-protocol-key="${cssEscape(definition.key)}"]`);
        if (textarea) textarea.value = getProtocolInstructionTemplate(definition.key);
    }

    updateAllProtocolInjectionPreviews();
}

function bindProtocolInjectionEditorUi() {
    const root = $('#aspect_vocalia_protocol_popup');
    if (!root.length || root.attr('data-protocol-bound') === 'true') return;

    shieldVocaliaPopupEditableEvents(root[0]);

    root.on('input change', '.aspect-vocalia-protocol-textarea', function () {
        const key = String($(this).attr('data-protocol-key') ?? '');
        if (!key) return;

        setProtocolInstructionTemplate(key, $(this).val());
        updateProtocolInjectionPreview(key);
    });

    root.on('click', '.aspect-vocalia-protocol-reset', function (event) {
        event.preventDefault();
        event.stopPropagation();

        const key = String($(this).attr('data-protocol-key') ?? '');
        if (!key) return;

        const value = resetProtocolInstructionTemplate(key);
        const textarea = root.find(`textarea[data-protocol-key="${cssEscape(key)}"]`).first();

        textarea.val(value);
        updateProtocolInjectionPreview(key);

        globalThis.toastr?.success('Protocol section reset.', MODULE_DISPLAY_NAME);
    });

    root.attr('data-protocol-bound', 'true');
}

function renderVocaliaInfoTip(key, label = 'More information') {
    const helpText = VOCALIA_LABEL_HELP[key];
    if (!helpText) return '';

    return `<span class="aspect-vocalia-info-tooltip" data-tooltip-key="${escapeHtml(key)}"><button
                type="button"
                class="aspect-vocalia-info-trigger"
                aria-label="${escapeHtml(label)}"
                aria-expanded="false"
            ><span class="aspect-vocalia-info-trigger-text" aria-hidden="true">i</span></button><span class="aspect-vocalia-info-bubble" role="tooltip">${escapeHtml(helpText)}</span></span>`;
}

function appendVocaliaInfoTip(target, key, label) {
    if (!target || !VOCALIA_LABEL_HELP[key]) return;
    if (target.querySelector?.(`.aspect-vocalia-info-tooltip[data-tooltip-key="${key}"]`)) return;

    target.insertAdjacentHTML('beforeend', renderVocaliaInfoTip(key, label));
}

function getVocaliaComparableLabelText(element) {
    if (!element) return '';

    const cloneElement = element.cloneNode(true);
    cloneElement.querySelectorAll('.aspect-vocalia-info-tooltip').forEach(node => node.remove());

    return cloneElement.textContent.trim();
}

function findVocaliaLabelByText(text, selector = '.aspect-vocalia-label-text, .aspect-vocalia-label, .aspect-vocalia-section-title, .aspect-vocalia-popup-title') {
    const root = document.getElementById('aspect_vocalia_settings');
    if (!root) return null;

    const normalized = String(text ?? '').trim();

    return Array.from(root.querySelectorAll(selector))
        .find(element => getVocaliaComparableLabelText(element) === normalized) ?? null;
}

function addVocaliaInfoTipsToSettings() {
    const root = document.getElementById('aspect_vocalia_settings');
    if (!root) return;

    appendVocaliaInfoTip(findVocaliaLabelByText('Critical Controls'), 'critical_controls', 'Explain Critical Controls');
    appendVocaliaInfoTip(findVocaliaLabelByText('Enable Extension'), 'enabled', 'Explain Enable Extension');
    appendVocaliaInfoTip(document.querySelector('#aspect_vocalia_settings .aspect-vocalia-reset-tip-anchor'), 'reset_extension', 'Explain Reset Extension');

    appendVocaliaInfoTip(findVocaliaLabelByText('Runtime'), 'runtime', 'Explain Runtime');
    appendVocaliaInfoTip(findVocaliaLabelByText('Change Group Reply Strategy to Manual Automatically'), 'auto_manual', 'Explain Manual Strategy');
    appendVocaliaInfoTip(findVocaliaLabelByText('Restore Original Group Reply Strategy Automatically'), 'restore_strategy', 'Explain Strategy Restore');

    appendVocaliaInfoTip(findVocaliaLabelByText('Turn Flow'), 'turn_flow', 'Explain Turn Flow');
    appendVocaliaInfoTip(findVocaliaLabelByText('Arrival Handling'), 'arrival_mode', 'Explain Arrival Handling');
    appendVocaliaInfoTip(findVocaliaLabelByText('On First Message, Trigger Character by Name Match'), 'first_name_match', 'Explain First Message Name Match');
    appendVocaliaInfoTip(findVocaliaLabelByText('If No Character Match on First Message'), 'first_fallback', 'Explain First Message Fallback');
    appendVocaliaInfoTip(findVocaliaLabelByText('Max Participants Per Turn'), 'max_participants', 'Explain Max Participants');
    appendVocaliaInfoTip(findVocaliaLabelByText('Max Responses Per Turn'), 'max_responses', 'Explain Max Responses');
    appendVocaliaInfoTip(findVocaliaLabelByText('Max Responses Per Participant Per Turn'), 'max_responses_per_participant', 'Explain Max Responses Per Participant');
    appendVocaliaInfoTip(findVocaliaLabelByText('Delay Between Responses'), 'response_delay', 'Explain Response Delay');

    appendVocaliaInfoTip(findVocaliaLabelByText('Refined Message Display'), 'refined_display', 'Explain Refined Message Display');
    appendVocaliaInfoTip(findVocaliaLabelByText('Display Raw Message as Refined Message'), 'render_overlay', 'Explain Refined Message');
    appendVocaliaInfoTip(findVocaliaLabelByText('Hide Empty Block Tags'), 'hide_empty_blocks', 'Explain Empty Block Tags');
    appendVocaliaInfoTip(findVocaliaLabelByText('Hide Character Name in Refined Message'), 'hide_character_name', 'Explain Character Name Display');
    appendVocaliaInfoTip(findVocaliaLabelByText('Hide Thoughts in Refined Message'), 'hide_thoughts', 'Explain Thought Display');
    appendVocaliaInfoTip(findVocaliaLabelByText('Wrap Dialogue in Quotes in Refined Message'), 'quote_dialogue', 'Explain Dialogue Quotes');
    appendVocaliaInfoTip(findVocaliaLabelByText('Style for Actions'), 'action_style', 'Explain Action Style');
    appendVocaliaInfoTip(findVocaliaLabelByText('Style for Narration'), 'narration_style', 'Explain Narration Style');
    appendVocaliaInfoTip(findVocaliaLabelByText('Style for Thoughts'), 'thoughts_style', 'Explain Thought Style');

    appendVocaliaInfoTip(findVocaliaLabelByText('Protocol'), 'protocol', 'Explain Protocol');
    appendVocaliaInfoTip(findVocaliaLabelByText('Protocol Injection Depth'), 'prompt_depth', 'Explain Protocol Depth');
    appendVocaliaInfoTip(findVocaliaLabelByText('Hide Debug Toasts'), 'hide_debug_toasts', 'Explain Debug Toasts');

    appendVocaliaInfoTip(findVocaliaLabelByText('Memory'), 'memory', 'Explain Memory');
    appendVocaliaInfoTip(findVocaliaLabelByText('Presence Required for Message Recall'), 'recall_presence', 'Explain Message Recall');

    appendVocaliaInfoTip(findVocaliaLabelByText('Status', '.aspect-vocalia-section-title'), 'status_section', 'Explain Status');
    appendVocaliaInfoTip(findVocaliaLabelByText('Status', '#aspect_vocalia_status_popup .aspect-vocalia-popup-title'), 'status_popup', 'Explain Status Popup');
    appendVocaliaInfoTip(document.querySelector('#aspect_vocalia_status_popup .aspect-vocalia-status-arrays-label'), 'status_arrays', 'Explain Scene Arrays');
    appendVocaliaInfoTip(document.querySelector('#aspect_vocalia_status_popup .aspect-vocalia-status-members-label'), 'status_member_table', 'Explain Status Configuration');
    appendVocaliaInfoTip(document.querySelector('#aspect_vocalia_status_popup .aspect-vocalia-sync-tip-anchor'), 'sync_state', 'Explain Sync Scene State');

    appendVocaliaInfoTip(findVocaliaLabelByText('Debug Log', '#aspect_vocalia_debug_popup .aspect-vocalia-popup-title'), 'debug_popup', 'Explain Debug Log');
    appendVocaliaInfoTip(document.querySelector('#aspect_vocalia_debug_popup .aspect-vocalia-debug-status-label'), 'debug_status', 'Explain Debug Status');
    appendVocaliaInfoTip(document.querySelector('#aspect_vocalia_debug_popup .aspect-vocalia-debug-controls-label'), 'debug_log_controls', 'Explain Debug Log Controls');
    appendVocaliaInfoTip(document.querySelector('#aspect_vocalia_debug_popup .aspect-vocalia-dump-state-tip-anchor'), 'dump_state', 'Explain Log State');

    appendVocaliaInfoTip(findVocaliaLabelByText('Utilities'), 'utilities', 'Explain Utilities');
    appendVocaliaInfoTip(document.querySelector('#aspect_vocalia_settings .aspect-vocalia-render-now-tip-anchor'), 'render_now', 'Explain Apply Render Setting');
}

function setupVocaliaInfoTooltips() {
    const root = document.getElementById('aspect_vocalia_settings');
    if (!root || root.dataset.infoTooltipsBound === 'true') return;

    const viewportPadding = 12;
    const tooltipLayerId = 'aspect_vocalia_tooltip_layer';

    let tooltipLayer = document.getElementById(tooltipLayerId);
    if (!tooltipLayer) {
        tooltipLayer = document.createElement('div');
        tooltipLayer.id = tooltipLayerId;
        tooltipLayer.className = 'aspect-vocalia-tooltip-layer';
        document.body.appendChild(tooltipLayer);
    }

    root.querySelectorAll('.aspect-vocalia-info-tooltip').forEach((tooltip, index) => {
        const bubble = tooltip.querySelector('.aspect-vocalia-info-bubble');
        if (!bubble) return;

        const bubbleId = bubble.id || `aspect_vocalia_tooltip_${index + 1}`;
        bubble.id = bubbleId;
        tooltip.dataset.tooltipBubbleId = bubbleId;

        if (bubble.parentElement !== tooltipLayer) {
            tooltipLayer.appendChild(bubble);
        }
    });

    const getTooltipParts = tooltip => {
        if (!tooltip) return { trigger: null, bubble: null };

        const trigger = tooltip.querySelector('.aspect-vocalia-info-trigger');
        const bubbleId = tooltip.dataset.tooltipBubbleId || '';
        const bubble = bubbleId ? document.getElementById(bubbleId) : null;

        return { trigger, bubble };
    };

    const clearTooltipPosition = bubble => {
        if (!bubble) return;

        bubble.classList.remove('is-active', 'is-measuring', 'is-positioned');
        bubble.style.removeProperty('--aspect-vocalia-tooltip-left');
        bubble.style.removeProperty('--aspect-vocalia-tooltip-top');
    };

    const updateTooltipPosition = tooltip => {
        if (!tooltip) return;

        const { trigger, bubble } = getTooltipParts(tooltip);
        if (!trigger || !bubble) return;

        bubble.classList.remove('is-positioned');
        bubble.classList.add('is-measuring');
        bubble.style.removeProperty('--aspect-vocalia-tooltip-left');
        bubble.style.removeProperty('--aspect-vocalia-tooltip-top');

        const triggerRect = trigger.getBoundingClientRect();
        const bubbleRect = bubble.getBoundingClientRect();
        const maxLeft = Math.max(viewportPadding, window.innerWidth - viewportPadding - bubbleRect.width);
        const desiredLeft = triggerRect.right - bubbleRect.width;
        const left = Math.min(Math.max(viewportPadding, desiredLeft), maxLeft);
        const top = Math.min(
            triggerRect.bottom + 8,
            Math.max(viewportPadding, window.innerHeight - viewportPadding - bubbleRect.height),
        );

        bubble.style.setProperty('--aspect-vocalia-tooltip-left', `${Math.round(left)}px`);
        bubble.style.setProperty('--aspect-vocalia-tooltip-top', `${Math.round(top)}px`);
        bubble.classList.remove('is-measuring');
        bubble.classList.add('is-positioned');
    };

    const hideTooltip = tooltip => {
        if (!tooltip) return;

        tooltip.classList.remove('is-open');
        tooltip.dataset.justClosed = 'true';

        setTimeout(() => {
            if (tooltip.dataset.justClosed === 'true') {
                delete tooltip.dataset.justClosed;
            }
        }, 0);

        const { trigger, bubble } = getTooltipParts(tooltip);
        if (trigger) trigger.setAttribute('aria-expanded', 'false');

        clearTooltipPosition(bubble);
    };

    const showTooltip = (tooltip, { pinned = false } = {}) => {
        if (!tooltip || tooltip.dataset.justClosed === 'true') return;

        const { trigger, bubble } = getTooltipParts(tooltip);
        if (!trigger || !bubble) return;

        bubble.classList.add('is-active');
        tooltip.classList.toggle('is-open', pinned);
        trigger.setAttribute('aria-expanded', pinned ? 'true' : 'false');
        updateTooltipPosition(tooltip);
    };

    const closeOpenTooltips = (except = null) => {
        root.querySelectorAll('.aspect-vocalia-info-tooltip').forEach(tooltip => {
            if (tooltip === except) return;
            hideTooltip(tooltip);
        });
    };

    root.addEventListener('pointerdown', event => {
        const trigger = event.target.closest('.aspect-vocalia-info-trigger');
        if (!trigger) return;

        event.preventDefault();
        event.stopPropagation();
    }, true);

    root.addEventListener('mouseenter', event => {
        const tooltip = event.target.closest('.aspect-vocalia-info-tooltip');
        if (!tooltip || tooltip.classList.contains('is-open')) return;

        closeOpenTooltips(tooltip);
        showTooltip(tooltip);
    }, true);

    root.addEventListener('mouseleave', event => {
        const tooltip = event.target.closest('.aspect-vocalia-info-tooltip');
        if (!tooltip || tooltip.classList.contains('is-open')) return;

        hideTooltip(tooltip);
    }, true);

    root.addEventListener('focusin', event => {
        const tooltip = event.target.closest('.aspect-vocalia-info-tooltip');
        if (!tooltip || tooltip.classList.contains('is-open')) return;

        closeOpenTooltips(tooltip);
        showTooltip(tooltip);
    });

    root.addEventListener('focusout', event => {
        const tooltip = event.target.closest('.aspect-vocalia-info-tooltip');
        if (!tooltip || tooltip.classList.contains('is-open')) return;

        const nextTarget = event.relatedTarget;
        if (nextTarget && tooltip.contains(nextTarget)) return;

        hideTooltip(tooltip);
    });

    root.addEventListener('click', event => {
        const trigger = event.target.closest('.aspect-vocalia-info-trigger');
        if (!trigger) return;

        const tooltip = trigger.closest('.aspect-vocalia-info-tooltip');
        if (!tooltip) return;

        event.preventDefault();
        event.stopPropagation();

        trigger.focus({ preventScroll: true });

        const willOpen = !tooltip.classList.contains('is-open');
        closeOpenTooltips(tooltip);

        if (!willOpen) {
            hideTooltip(tooltip);
            return;
        }

        showTooltip(tooltip, { pinned: true });
    });

    root.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        closeOpenTooltips();
    });

    document.addEventListener('pointerdown', event => {
        if (event.target.closest('#aspect_vocalia_settings .aspect-vocalia-info-tooltip')) return;
        closeOpenTooltips();
    }, true);

    window.addEventListener('resize', () => {
        root.querySelectorAll('.aspect-vocalia-info-tooltip.is-open').forEach(updateTooltipPosition);
    });

    window.addEventListener('scroll', () => closeOpenTooltips(), true);

    root.dataset.infoTooltipsBound = 'true';
}

// ============================================================================
// Section 19. Settings UI Diagnostics, Popups, and Display Helpers
// ============================================================================
// Purpose:
// - Own popup positioning and diagnostics rendering.
// - Render member status rows and scene arrays.
// - Render overlay style options.
// - Own inverted setting helpers and reset behavior.
// ============================================================================

function clampVocaliaNumber(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function closeVocaliaPopups() {
    $('.aspect-vocalia-popup')
        .removeClass('aspect-vocalia-popup-open')
        .css({
            '--aspect-vocalia-popup-left': '',
            '--aspect-vocalia-popup-top': '',
        });
}

function positionVocaliaPopupInViewport($popup, button) {
    const popupElement = $popup?.[0];

    if (!popupElement || !button) return;

    const margin = 8;
    const buttonRect = button.getBoundingClientRect();

    $popup.css({
        '--aspect-vocalia-popup-left': `${margin}px`,
        '--aspect-vocalia-popup-top': `${margin}px`,
    });

    requestAnimationFrame(() => {
        if (!$popup.hasClass('aspect-vocalia-popup-open')) return;

        const popupWidth = Math.min(popupElement.offsetWidth || 260, window.innerWidth - (margin * 2));
        const popupHeight = Math.min(popupElement.offsetHeight || 0, window.innerHeight - (margin * 2));

        const maxLeft = Math.max(margin, window.innerWidth - popupWidth - margin);
        const maxTop = Math.max(margin, window.innerHeight - popupHeight - margin);

        const left = clampVocaliaNumber(buttonRect.left, margin, maxLeft);
        let top = buttonRect.bottom + 4;

        if (top > maxTop && buttonRect.top - popupHeight - 4 >= margin) {
            top = buttonRect.top - popupHeight - 4;
        }

        top = clampVocaliaNumber(top, margin, maxTop);

        $popup.css({
            '--aspect-vocalia-popup-left': `${left}px`,
            '--aspect-vocalia-popup-top': `${top}px`,
        });
    });
}

function toggleVocaliaPopup(button, popupSelector) {
    const $popup = $(popupSelector);
    const wasOpen = $popup.hasClass('aspect-vocalia-popup-open');

    closeVocaliaPopups();

    if (!wasOpen) {
        $popup.addClass('aspect-vocalia-popup-open');
        positionVocaliaPopupInViewport($popup, button);
    }
}

function stopVocaliaPopupEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
}

function getNamesForAvatars(avatars) {
    const members = getGroupMembers();
    const byAvatar = new Map(members.map(member => [member.avatar, member.name]));

    return [...new Set(avatars ?? [])]
        .map(avatar => byAvatar.get(avatar) ?? avatar)
        .filter(Boolean);
}

function getIdleAvatars() {
    const state = getChatState();

    return [...new Set([...(state.present ?? []), ...(state.remote ?? [])])].filter(avatar => {
        const memberState = state.members?.[avatar];
        return memberState?.lastStatus === MEMBER_STATUS_IDLE || !memberState?.lastStatus;
    });
}

function getDepartingAvatars() {
    const state = getChatState();

    return Object.entries(state.members ?? {})
        .filter(([_avatar, memberState]) => memberState?.lastStatus === MEMBER_STATUS_DEPARTING)
        .map(([avatar]) => avatar);
}

function getDiagnosticStatusForMember(member) {
    const state = ensureStateForCurrentGroup();
    const avatar = member.avatar;
    const memberState = state.members?.[avatar];

    if ((state.pendingArrivals ?? []).includes(avatar)) return MEMBER_STATUS_ARRIVING;
    if (memberState?.lastStatus === MEMBER_STATUS_DEPARTING) return MEMBER_STATUS_DEPARTING;
    if ((state.present ?? []).includes(avatar)) return MEMBER_STATUS_PRESENT;
    if ((state.remote ?? []).includes(avatar)) return MEMBER_STATUS_REMOTE;
    if ((state.absent ?? []).includes(avatar)) return MEMBER_STATUS_ABSENT;
    if (memberState?.lastStatus === MEMBER_STATUS_IDLE) return MEMBER_STATUS_IDLE;

    return MEMBER_STATUS_ABSENT;
}

function setDiagnosticStatusForMember(avatar, status) {
    const state = ensureStateForCurrentGroup();
    const member = getMemberByAvatar(avatar);

    if (!member || !state.members?.[avatar]) return;

    switch (status) {
        case MEMBER_STATUS_ARRIVING:
            setPresence(avatar, MEMBER_STATUS_ARRIVING);
            state.members[avatar].lastStatus = MEMBER_STATUS_ARRIVING;
            break;

        case MEMBER_STATUS_PRESENT:
            setPresence(avatar, MEMBER_STATUS_PRESENT);
            state.members[avatar].lastStatus = MEMBER_STATUS_PRESENT;
            break;

        case MEMBER_STATUS_REMOTE:
            setPresence(avatar, MEMBER_STATUS_REMOTE);
            state.members[avatar].lastStatus = MEMBER_STATUS_REMOTE;
            break;

        case MEMBER_STATUS_IDLE:
            if (isAvatarRemote(avatar, state)) {
                setPresence(avatar, MEMBER_STATUS_REMOTE);
            } else {
                setPresence(avatar, MEMBER_STATUS_PRESENT);
            }
            state.members[avatar].lastStatus = MEMBER_STATUS_IDLE;
            break;

        case MEMBER_STATUS_DEPARTING:
            if (!isAvatarRouteEligible(avatar, state)) {
                setPresence(avatar, MEMBER_STATUS_PRESENT);
            }
            state.members[avatar].lastStatus = MEMBER_STATUS_DEPARTING;
            break;

        case MEMBER_STATUS_ABSENT:
        default:
            setPresence(avatar, MEMBER_STATUS_ABSENT);
            state.members[avatar].lastStatus = MEMBER_STATUS_IDLE;
            break;
    }

    state.members[avatar].manualDiagnosticStatusChangedAt = Date.now();
    normalizeRosterArrays(state, getGroupMembers());
}

function renderStatusOptions(selectedStatus) {
    const options = [
        [MEMBER_STATUS_PRESENT, 'Present'],
        [MEMBER_STATUS_REMOTE, 'Remote'],
        [MEMBER_STATUS_IDLE, 'Idle'],
        [MEMBER_STATUS_ARRIVING, 'Arriving'],
        [MEMBER_STATUS_DEPARTING, 'Departing'],
        [MEMBER_STATUS_ABSENT, 'Absent'],
    ];

    return options.map(([value, label]) => {
        const selected = value === selectedStatus ? ' selected' : '';
        return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(label)}</option>`;
    }).join('');
}

function renderOverlayStyleOptions(selectedStyle) {
    const normalizedSelectedStyle = normalizeOverlayStyle(selectedStyle);

    const options = [
        [OVERLAY_STYLE_PLAIN, 'None'],
        ['muted', 'Muted'],

        [OVERLAY_STYLE_BOLD, 'Bold'],
        [OVERLAY_STYLE_ITALIC, 'Italics'],
        [OVERLAY_STYLE_BOLD_ITALIC, 'Bold Italics'],
        ['muted_bold', 'Muted Bold'],
        [OVERLAY_STYLE_ASTERISKS, 'Muted Italics'],

        [OVERLAY_STYLE_UNDERLINE, 'Underline'],
        ['muted_underline', 'Muted Underline'],

        [OVERLAY_STYLE_STRIKE, 'Strike-through'],
        ['muted_strike', 'Muted Strike-through'],

        [OVERLAY_STYLE_UPPERCASE, 'Uppercase'],
        ['muted_uppercase', 'Muted Uppercase'],

        [OVERLAY_STYLE_LOWERCASE, 'Lowercase'],
        ['muted_lowercase', 'Muted Lowercase'],
    ];

    return options.map(([value, label]) => {
        const selected = value === normalizedSelectedStyle ? ' selected' : '';
        return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(label)}</option>`;
    }).join('');
}

function renderDiagnosticMemberRows() {
    const members = getGroupMembers();
    const limits = getTurnLimitSettings();

    if (!members.length) {
        return `
            <tr>
                <td colspan="4">
                    <em>No active group chat detected.</em>
                </td>
            </tr>`;
    }

    return members.map(member => {
        const status = getDiagnosticStatusForMember(member);
        const responseCount = getParticipantResponseCount(member);
        const allowanceText = `${responseCount}/${limits.maxResponsesPerParticipantPerTurn}`;
        const enabledText = member.disabled ? 'false' : 'true';

        return `
            <tr data-avatar="${escapeHtml(member.avatar)}">
                <td>
                    <div class="aspect-vocalia-member-name">${escapeHtml(member.name)}</div>
                    <div class="aspect-vocalia-member-avatar">${escapeHtml(member.avatar)}</div>
                </td>
                <td>${escapeHtml(enabledText)}</td>
                <td>${escapeHtml(allowanceText)}</td>
                <td>
                    <select class="text_pole aspect_vocalia_member_status_select" data-avatar="${escapeHtml(member.avatar)}">
                        ${renderStatusOptions(status)}
                    </select>
                </td>
            </tr>`;
    }).join('');
}

function updateDiagnosticsPanel() {
    if (!$('#aspect_vocalia_settings').length) return;

    ensureStateForCurrentGroup();

    const state = getChatState();
    const presentNames = getNamesForAvatars(state.present);
    const remoteNames = getNamesForAvatars(state.remote);
    const absentNames = getNamesForAvatars(state.absent);
    const arrivingNames = getNamesForAvatars(state.pendingArrivals);
    const idleNames = getNamesForAvatars(getIdleAvatars());
    const departingNames = getNamesForAvatars(getDepartingAvatars());
    const triggeredNames = getNamesForAvatars(state.triggeredThisTurn ?? []);

    const formatArray = names => names.length ? names.join(', ') : 'none';

    $('#aspect_vocalia_array_present').text(formatArray(presentNames));
    $('#aspect_vocalia_array_remote').text(formatArray(remoteNames));
    $('#aspect_vocalia_array_idle').text(formatArray(idleNames));
    $('#aspect_vocalia_array_arriving').text(formatArray(arrivingNames));
    $('#aspect_vocalia_array_departing').text(formatArray(departingNames));
    $('#aspect_vocalia_array_absent').text(formatArray(absentNames));
    $('#aspect_vocalia_array_triggered').text(formatArray(triggeredNames));
    $('#aspect_vocalia_member_state_table tbody').html(renderDiagnosticMemberRows());

    updateDebugLogUi();
}

function updateDebugLogUi() {
    if (!$('#aspect_vocalia_settings').length) return;

    $('#aspect_vocalia_debug_active').text(vocaliaDebugActive ? 'yes' : 'no');
    $('#aspect_vocalia_debug_entries').text(String(vocaliaDebugEntries.length));
    $('#aspect_vocalia_debug_started').text(vocaliaDebugStartedAt ?? 'not started');
    $('#aspect_vocalia_debug_stopped').text(vocaliaDebugStoppedAt ?? 'not stopped');
}

function getRefinedMessageCharacterNameHidden(settings = getSettings()) {
    if (Object.hasOwn(settings, 'hideCharacterNameInRefinedMessage')) {
        return !!settings.hideCharacterNameInRefinedMessage;
    }

    return !Boolean(settings.showCharacterLabels);
}

function getRefinedMessageThoughtsHidden(settings = getSettings()) {
    if (Object.hasOwn(settings, 'hideThoughtsInRefinedMessage')) {
        return !!settings.hideThoughtsInRefinedMessage;
    }

    return !Boolean(settings.showThoughts);
}

function getDebugToastsHidden(settings = getSettings()) {
    if (Object.hasOwn(settings, 'hideDebugToasts')) {
        return !!settings.hideDebugToasts;
    }

    return !Boolean(settings.showDebugToasts);
}

function setInvertedBooleanSetting(newKey, legacyKey, hidden) {
    const settings = getSettings();
    settings[newKey] = !!hidden;

    try {
        settings[legacyKey] = !Boolean(hidden);
    } catch {
        // Compatibility alias may be read-only in a future implementation.
    }

    saveSettings();
}

function formatDelaySeconds(milliseconds) {
    const seconds = Math.max(0, Number(milliseconds || 0) / 1000);
    return Number(seconds.toFixed(3)).toString();
}

function clampDelaySeconds(value) {
    return Math.min(10, Math.max(0, Number(value) || 0));
}

async function resetVocaliaExtension() {
    const confirmed = window.confirm(
        'Reset Aspect: Vocalia?\n\n' +
        'This will restore extension settings to defaults, clear Vocalia state for the current chat, stop any active queue/debug logging, and resync the current group state.',
    );

    if (!confirmed) return;

    const context = ctx();

    triggerQueue = [];
    queueRunning = false;
    vocaliaEmptySendInProgress = false;
    vocaliaControlledGenerationInProgress = false;

    for (const waiter of vocaliaPendingTriggerWaiters) {
        if (waiter.timer) clearTimeout(waiter.timer);
    }

    vocaliaPendingTriggerWaiters = [];
    vocaliaRecentTriggerAttempts = [];

    clearActiveGenerationTarget?.('reset_extension');
    clearVocaliaDebugLog();

    context.extensionSettings[MODULE_NAME] = clone(DEFAULT_SETTINGS);
    context.chatMetadata[MODULE_NAME] = clone(DEFAULT_CHAT_STATE);

    ensureStateForCurrentGroup();
    updateExtensionPrompt();
    applyOverlaySettingToVisibleMessages();
    updateDiagnosticsPanel();

    saveSettings();
    await saveMetadata();

    loadSettingsUi();

    if (getSettings().enabled) {
        await enableRuntime();
    } else {
        await disableRuntime();
    }

    globalThis.toastr?.success('Aspect: Vocalia has been reset.', MODULE_DISPLAY_NAME);
}

// ============================================================================
// Section 20. Settings Drawer Rendering and Binding
// ============================================================================
// Purpose:
// - Build the Aspect: Vocalia drawer UI.
// - Move Presence Required for Message Recall into its own Memory section.
// - Keep Status popup button on its own line under the Status header.
// - Bind all controls to settings, diagnostics, popups, and utilities.
// ============================================================================

function injectSettingsUi() {
    if ($('#aspect_vocalia_settings').length) return;

    const html = `
    <div id="aspect_vocalia_settings" class="aspect_vocalia_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>${escapeHtml(MODULE_DISPLAY_NAME)}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>

            <div class="inline-drawer-content">
                <div class="aspect-vocalia-settings-box">
                    <div class="aspect-vocalia-settings-tagline">The Aspect of Voice</div>

                    <div class="aspect-vocalia-critical-box">
                        <div class="aspect-vocalia-section-title">Critical Controls</div>

                        <div class="aspect-vocalia-critical-enable-row">
                            <label class="checkbox_label">
                                <input id="av_enabled" type="checkbox">
                                <span class="aspect-vocalia-label-text">Enable Extension</span>
                            </label>
                        </div>

                        <div class="aspect-vocalia-critical-button-row">
                            <span class="aspect-vocalia-control-with-tip aspect-vocalia-reset-tip-anchor">
                                <button
                                    id="av_reset_extension"
                                    type="button"
                                    class="menu_button danger_button"
                                    title="Reset Aspect: Vocalia settings and current chat state."
                                >
                                    Reset Extension
                                </button>
                            </span>

                            <span class="aspect-vocalia-popup-wrap">
                                <button
                                    id="av_debug_popup_button"
                                    type="button"
                                    class="menu_button aspect-vocalia-popup-button"
                                >
                                    Debug Log
                                </button>

                                <div id="aspect_vocalia_debug_popup" class="aspect-vocalia-popup">
                                    <div class="aspect-vocalia-popup-title">Debug Log</div>

                                    <div class="aspect-vocalia-label aspect-vocalia-debug-status-label">Debug status</div>
                                    <div class="aspect-vocalia-debug-status">
                                        <div>Active: <code id="aspect_vocalia_debug_active">no</code></div>
                                        <div>Entries: <code id="aspect_vocalia_debug_entries">0</code></div>
                                        <div>Started: <code id="aspect_vocalia_debug_started">not started</code></div>
                                        <div>Stopped: <code id="aspect_vocalia_debug_stopped">not stopped</code></div>
                                    </div>

                                    <div class="aspect-vocalia-label aspect-vocalia-debug-controls-label">Debug controls</div>
                                    <div class="aspect-vocalia-button-row">
                                        <input id="av_debug_start" class="menu_button" type="button" value="Start logging">
                                        <input id="av_debug_stop" class="menu_button" type="button" value="Stop logging">
                                        <input id="av_debug_copy" class="menu_button" type="button" value="Copy log">
                                        <input id="av_debug_download" class="menu_button" type="button" value="Download log">
                                        <input id="av_debug_clear" class="menu_button" type="button" value="Clear log">
                                    </div>

                                    <div class="aspect-vocalia-button-row">
                                        <span class="aspect-vocalia-control-with-tip aspect-vocalia-dump-state-tip-anchor">
                                            <input id="av_dump_state" class="menu_button" type="button" value="Log state">
                                        </span>
                                    </div>
                                </div>
                            </span>
                        </div>
                    </div>

                    <div class="aspect-vocalia-settings-section">
                        <div class="aspect-vocalia-section-title">Runtime</div>

                        <div class="flex-container flexFlowColumn">
                            <label class="checkbox_label">
                                <input id="av_auto_manual" type="checkbox">
                                <span class="aspect-vocalia-label-text">Change Group Reply Strategy to Manual Automatically</span>
                            </label>

                            <label class="checkbox_label">
                                <input id="av_restore_strategy" type="checkbox">
                                <span class="aspect-vocalia-label-text">Restore Original Group Reply Strategy Automatically</span>
                            </label>
                        </div>
                    </div>

                    <div class="aspect-vocalia-settings-section">
                        <div class="aspect-vocalia-section-title">Turn Flow</div>

                        <div class="flex-container flexFlowColumn">
                            <label for="av_arrival_mode" class="aspect-vocalia-label">Arrival Handling</label>
                            <select id="av_arrival_mode" class="text_pole">
                                <option value="${ARRIVAL_APPLY_IMMEDIATE}">Immediately when the first assistant declares it</option>
                                <option value="${ARRIVAL_APPLY_DEFERRED}">After the current auto-reply chain ends</option>
                            </select>

                            <label class="checkbox_label">
                                <input id="av_first_name_match" type="checkbox">
                                <span class="aspect-vocalia-label-text">On First Message, Trigger Character by Name Match</span>
                            </label>

                            <label for="av_first_fallback" class="aspect-vocalia-label">If No Character Match on First Message</label>
                            <select id="av_first_fallback" class="text_pole">
                                <option value="${FIRST_MESSAGE_FALLBACK_RANDOM_PRESENT}">Trigger a random eligible group member</option>
                                <option value="${FIRST_MESSAGE_FALLBACK_FIRST_PRESENT}">Trigger first eligible group member</option>
                                <option value="${FIRST_MESSAGE_FALLBACK_DO_NOTHING}">Do nothing</option>
                            </select>

                            <div class="flex-container alignItemsCenter">
                                <label for="av_max_participants" class="flexGrow aspect-vocalia-label">Max Participants Per Turn</label>
                                <input id="av_max_participants" class="text_pole widthUnset" type="number" min="1" max="10" step="1">
                            </div>

                            <div class="flex-container alignItemsCenter">
                                <label for="av_max_responses" class="flexGrow aspect-vocalia-label">Max Responses Per Turn</label>
                                <input id="av_max_responses" class="text_pole widthUnset" type="number" min="0" max="50" step="1">
                            </div>

                            <div class="flex-container alignItemsCenter">
                                <label for="av_max_responses_per_participant" class="flexGrow aspect-vocalia-label">Max Responses Per Participant Per Turn</label>
                                <input id="av_max_responses_per_participant" class="text_pole widthUnset" type="number" min="1" max="3" step="1">
                            </div>

                            <div class="flex-container alignItemsCenter">
                                <label for="av_trigger_delay" class="flexGrow aspect-vocalia-label">Delay Between Responses</label>
                                <span>
                                    <input id="av_trigger_delay" class="text_pole widthUnset" type="number" min="0" max="10" step="0.05">
                                    <span class="aspect-vocalia-inline-unit">Seconds</span>
                                </span>
                            </div>
                        </div>
                    </div>

                    <div class="aspect-vocalia-settings-section">
                        <div class="aspect-vocalia-section-title">Refined Message Display</div>

                        <div class="flex-container flexFlowColumn">
                            <label class="checkbox_label">
                                <input id="av_render_overlay" type="checkbox">
                                <span class="aspect-vocalia-label-text">Display Raw Message as Refined Message</span>
                            </label>

                            <label class="checkbox_label">
                                <input id="av_hide_empty_sections" type="checkbox">
                                <span class="aspect-vocalia-label-text">Hide Empty Block Tags</span>
                            </label>

                            <label class="checkbox_label">
                                <input id="av_hide_character_name" type="checkbox">
                                <span class="aspect-vocalia-label-text">Hide Character Name in Refined Message</span>
                            </label>

                            <label class="checkbox_label">
                                <input id="av_hide_thoughts" type="checkbox">
                                <span class="aspect-vocalia-label-text">Hide Thoughts in Refined Message</span>
                            </label>

                            <label class="checkbox_label">
                                <input id="av_quote_dialogue" type="checkbox">
                                <span class="aspect-vocalia-label-text">Wrap Dialogue in Quotes in Refined Message</span>
                            </label>

                            <label for="av_action_style" class="aspect-vocalia-label">Style for Actions</label>
                            <select id="av_action_style" class="text_pole">
                                ${renderOverlayStyleOptions(getSettings().actionDisplayStyle)}
                            </select>

                            <label for="av_narration_style" class="aspect-vocalia-label">Style for Narration</label>
                            <select id="av_narration_style" class="text_pole">
                                ${renderOverlayStyleOptions(getSettings().narrationDisplayStyle)}
                            </select>

                            <label for="av_thoughts_style" class="aspect-vocalia-label">Style for Thoughts</label>
                            <select id="av_thoughts_style" class="text_pole">
                                ${renderOverlayStyleOptions(getSettings().thoughtsDisplayStyle)}
                            </select>
                        </div>
                    </div>

                    <div class="aspect-vocalia-settings-section">
                        <div class="aspect-vocalia-section-title">Protocol</div>

                        <div class="flex-container flexFlowColumn">
                            <span class="aspect-vocalia-popup-wrap">
                                <button
                                    id="av_protocol_popup_button"
                                    type="button"
                                    class="menu_button aspect-vocalia-popup-button"
                                >
                                    Protocol Injection
                                </button>

                                <div id="aspect_vocalia_protocol_popup" class="aspect-vocalia-popup">
                                    <div class="aspect-vocalia-popup-title">Protocol Injection</div>
                                    <div class="aspect-vocalia-protocol-preview">Edit the concise instruction templates Vocalia injects into the LLM prompt. Placeholders such as {{tagPrefix}}, {{allMembers}}, and {{maxParticipants}} are filled at generation time.</div>
                                    ${renderProtocolInjectionEditorFields()}
                                </div>
                            </span>

                            <div class="flex-container alignItemsCenter">
                                <label for="av_prompt_depth" class="flexGrow aspect-vocalia-label">Protocol Injection Depth</label>
                                <input id="av_prompt_depth" class="text_pole widthUnset" type="number" min="0" max="100" step="1">
                            </div>

                            <label class="checkbox_label">
                                <input id="av_hide_debug_toasts" type="checkbox">
                                <span class="aspect-vocalia-label-text">Hide Debug Toasts</span>
                            </label>
                        </div>
                    </div>

                    <div class="aspect-vocalia-settings-section">
                        <div class="aspect-vocalia-section-title">Memory</div>

                        <div class="flex-container flexFlowColumn">
                            <label class="checkbox_label">
                                <input id="av_occlude_history" type="checkbox">
                                <span class="aspect-vocalia-label-text">Presence Required for Message Recall</span>
                            </label>
                        </div>
                    </div>

                    <div class="aspect-vocalia-settings-section">
                        <div class="aspect-vocalia-section-title">Status</div>

                        <div class="aspect-vocalia-button-row">
                            <span class="aspect-vocalia-popup-wrap">
                                <button
                                    id="av_status_popup_button"
                                    type="button"
                                    class="menu_button aspect-vocalia-popup-button"
                                >
                                    Status
                                </button>

                                <div id="aspect_vocalia_status_popup" class="aspect-vocalia-popup">
                                    <div class="aspect-vocalia-popup-title">Status</div>

                                    <div class="aspect-vocalia-label aspect-vocalia-status-arrays-label">Scene arrays</div>
                                    <div class="aspect-vocalia-array-list">
                                        <div>Present: <code id="aspect_vocalia_array_present">none</code></div>
                                        <div>Remote: <code id="aspect_vocalia_array_remote">none</code></div>
                                        <div>Idle: <code id="aspect_vocalia_array_idle">none</code></div>
                                        <div>Arriving: <code id="aspect_vocalia_array_arriving">none</code></div>
                                        <div>Departing: <code id="aspect_vocalia_array_departing">none</code></div>
                                        <div>Absent: <code id="aspect_vocalia_array_absent">none</code></div>
                                        <div>Triggered this user turn: <code id="aspect_vocalia_array_triggered">none</code></div>
                                    </div>

                                    <div class="aspect-vocalia-label aspect-vocalia-status-members-label">Status Configuration</div>
                                    <table id="aspect_vocalia_member_state_table">
                                        <thead>
                                            <tr>
                                                <th>Participants</th>
                                                <th>Enabled</th>
                                                <th>Responses</th>
                                                <th>Status</th>
                                            </tr>
                                        </thead>
                                        <tbody></tbody>
                                    </table>

                                    <div class="aspect-vocalia-button-row">
                                        <span class="aspect-vocalia-control-with-tip aspect-vocalia-sync-tip-anchor">
                                            <input id="av_sync_state" class="menu_button" type="button" value="Sync scene state from group">
                                        </span>
                                    </div>
                                </div>
                            </span>
                        </div>
                    </div>

                    <div class="aspect-vocalia-settings-section">
                        <div class="aspect-vocalia-section-title">Utilities</div>

                        <div class="aspect-vocalia-button-row">
                            <span class="aspect-vocalia-control-with-tip aspect-vocalia-render-now-tip-anchor">
                                <input id="av_render_now" class="menu_button" type="button" value="Apply render setting now">
                            </span>
                        </div>
                    </div>

                    <div class="aspect-vocalia-footer-divider">
                        <div class="aspect-vocalia-settings-footer">
                            <span id="aspect_vocalia_settings_version">Version ${escapeHtml(vocaliaManifestMeta.version)}</span>
                            <span id="aspect_vocalia_settings_author">${escapeHtml(vocaliaManifestMeta.author)}</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>`;

    const settingsPanel = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    settingsPanel.append(html);

    renderVocaliaSettingsFooter();
    void loadVocaliaManifestMetadata();

    addVocaliaInfoTipsToSettings();
    setupVocaliaInfoTooltips();

    bindSettingsUi();
}

function loadSettingsUi() {
    const settings = getSettings();

    $('#av_enabled').prop('checked', !!settings.enabled);
    $('#av_auto_manual').prop('checked', !!settings.autoSetManual);
    $('#av_restore_strategy').prop('checked', !!settings.restoreOriginalStrategyOnDisable);
    $('#av_occlude_history').prop('checked', !!settings.occludeUnwitnessedHistory);

    $('#av_arrival_mode').val(settings.arrivalApplyMode);
    $('#av_first_name_match').prop('checked', !!settings.triggerNamedCharacterOnFirstUserMessage);
    $('#av_first_fallback').val(settings.firstMessageFallback);

    $('#av_max_participants').val(String(settings.maxParticipantsPerTurn));
    $('#av_max_responses').val(String(settings.maxResponsesPerTurn));
    $('#av_max_responses_per_participant').val(String(settings.maxResponsesPerParticipantPerTurn));
    $('#av_trigger_delay').val(formatDelaySeconds(settings.triggerDelayMs));

    $('#av_render_overlay').prop('checked', !!settings.renderOverlay);
    $('#av_hide_empty_sections').prop('checked', !!settings.hideEmptySections);
    $('#av_hide_character_name').prop('checked', getRefinedMessageCharacterNameHidden(settings));
    $('#av_hide_thoughts').prop('checked', getRefinedMessageThoughtsHidden(settings));
    $('#av_quote_dialogue').prop('checked', !!settings.quoteDialogue);

    $('#av_action_style').val(normalizeOverlayStyle(settings.actionDisplayStyle));
    $('#av_narration_style').val(normalizeOverlayStyle(settings.narrationDisplayStyle));
    $('#av_thoughts_style').val(normalizeOverlayStyle(settings.thoughtsDisplayStyle));

    $('#av_prompt_depth').val(String(settings.promptDepth));
    $('#av_hide_debug_toasts').prop('checked', getDebugToastsHidden(settings));

    loadProtocolInjectionEditorUi();

    updateDiagnosticsPanel();
    updateDebugLogUi();
    renderVocaliaSettingsFooter();
}

function bindSettingsUi() {
    const bindCheckbox = (selector, key, after = null) => {
        $(selector).on('change', async function () {
            getSettings()[key] = !!$(this).prop('checked');
            saveSettings();
            if (typeof after === 'function') await after();
        });
    };

    const bindNumber = (selector, key, min, max, after = null) => {
        $(selector).on('change input', async function () {
            const value = Math.min(max, Math.max(min, Math.round(Number($(this).val()) || 0)));
            getSettings()[key] = value;
            $(this).val(String(value));
            saveSettings();
            if (typeof after === 'function') await after();
        });
    };

    const bindDelaySeconds = (selector, after = null) => {
        $(selector).on('change input', async function () {
            const seconds = clampDelaySeconds($(this).val());
            const milliseconds = Math.round(seconds * 1000);

            getSettings().triggerDelayMs = milliseconds;
            $(this).val(formatDelaySeconds(milliseconds));
            saveSettings();

            if (typeof after === 'function') await after();
        });
    };

    const bindSelect = (selector, key, after = null) => {
        $(selector).on('change', async function () {
            getSettings()[key] = normalizeOverlayStyle(String($(this).val()));
            saveSettings();
            if (typeof after === 'function') await after();
        });
    };

    const bindPlainSelect = (selector, key, after = null) => {
        $(selector).on('change', async function () {
            getSettings()[key] = String($(this).val());
            saveSettings();
            if (typeof after === 'function') await after();
        });
    };

    bindCheckbox('#av_enabled', 'enabled', async () => {
        if (getSettings().enabled) await enableRuntime();
        else await disableRuntime();
    });

    bindCheckbox('#av_auto_manual', 'autoSetManual', async () => forceManualStrategyForCurrentGroup());
    bindCheckbox('#av_restore_strategy', 'restoreOriginalStrategyOnDisable');

    bindPlainSelect('#av_arrival_mode', 'arrivalApplyMode', async () => {
        if (getSettings().arrivalApplyMode === ARRIVAL_APPLY_IMMEDIATE) {
            applyPendingArrivals();
            await saveMetadata();
        }

        updateExtensionPrompt();
        updateDiagnosticsPanel();
    });

    bindCheckbox('#av_first_name_match', 'triggerNamedCharacterOnFirstUserMessage');
    bindPlainSelect('#av_first_fallback', 'firstMessageFallback');

    bindNumber('#av_max_participants', 'maxParticipantsPerTurn', 1, 10, async () => updateExtensionPrompt());
    bindNumber('#av_max_responses', 'maxResponsesPerTurn', 0, 50, async () => updateExtensionPrompt());
    bindNumber('#av_max_responses_per_participant', 'maxResponsesPerParticipantPerTurn', 1, 3, async () => {
        updateDiagnosticsPanel();
        updateExtensionPrompt();
    });
    bindDelaySeconds('#av_trigger_delay');

    bindCheckbox('#av_render_overlay', 'renderOverlay', async () => {
        applyOverlaySettingToVisibleMessages();
    });

    bindCheckbox('#av_hide_empty_sections', 'hideEmptySections', async () => renderAllVisibleOverlays());

    $('#av_hide_character_name').on('change', async function () {
        setInvertedBooleanSetting('hideCharacterNameInRefinedMessage', 'showCharacterLabels', !!$(this).prop('checked'));
        await renderAllVisibleOverlays();
    });

    $('#av_hide_thoughts').on('change', async function () {
        setInvertedBooleanSetting('hideThoughtsInRefinedMessage', 'showThoughts', !!$(this).prop('checked'));
        await renderAllVisibleOverlays();
    });

    bindCheckbox('#av_quote_dialogue', 'quoteDialogue', async () => renderAllVisibleOverlays());

    bindSelect('#av_action_style', 'actionDisplayStyle', async () => renderAllVisibleOverlays());
    bindSelect('#av_narration_style', 'narrationDisplayStyle', async () => renderAllVisibleOverlays());
    bindSelect('#av_thoughts_style', 'thoughtsDisplayStyle', async () => renderAllVisibleOverlays());

    bindNumber('#av_prompt_depth', 'promptDepth', 0, 100, async () => updateExtensionPrompt());

    $('#av_hide_debug_toasts').on('change', function () {
        setInvertedBooleanSetting('hideDebugToasts', 'showDebugToasts', !!$(this).prop('checked'));
    });

    bindCheckbox('#av_occlude_history', 'occludeUnwitnessedHistory');

    $('#av_status_popup_button').on('click', function (event) {
        stopVocaliaPopupEvent(event);
        updateDiagnosticsPanel();
        toggleVocaliaPopup(this, '#aspect_vocalia_status_popup');
    });

    $('#av_debug_popup_button').on('click', function (event) {
        stopVocaliaPopupEvent(event);
        updateDebugLogUi();
        toggleVocaliaPopup(this, '#aspect_vocalia_debug_popup');
    });

    $('#av_protocol_popup_button').on('click', function (event) {
        stopVocaliaPopupEvent(event);
        loadProtocolInjectionEditorUi();
        toggleVocaliaPopup(this, '#aspect_vocalia_protocol_popup');
    });

    $('#aspect_vocalia_settings').on('click', '.aspect-vocalia-popup', function (event) {
        event.stopPropagation();
        event.stopImmediatePropagation();
    });

    $(document)
        .off('click.aspectVocaliaPopups')
        .on('click.aspectVocaliaPopups', function (event) {
            const $target = $(event.target);

            if ($target.closest('#aspect_vocalia_settings .aspect-vocalia-popup-wrap').length) {
                return;
            }

            closeVocaliaPopups();
        });

    $(window)
        .off('resize.aspectVocaliaPopups scroll.aspectVocaliaPopups')
        .on('resize.aspectVocaliaPopups scroll.aspectVocaliaPopups', () => {
            closeVocaliaPopups();
        });

    $('#aspect_vocalia_member_state_table').on('change', '.aspect_vocalia_member_status_select', async function () {
        const avatar = String($(this).attr('data-avatar') ?? '');
        const status = String($(this).val() ?? MEMBER_STATUS_ABSENT);

        logVocaliaEvent('diagnostics.manual_status_change', {
            avatar,
            name: avatarToDebugName(avatar),
            status,
        });

        setDiagnosticStatusForMember(avatar, status);
        updateExtensionPrompt();
        updateDiagnosticsPanel();
        await saveMetadata();
    });

    $('#av_debug_start').on('click', () => {
        startVocaliaDebugLog();
        globalThis.toastr?.success('Vocalia debug logging started.', MODULE_DISPLAY_NAME);
    });

    $('#av_debug_stop').on('click', () => {
        stopVocaliaDebugLog();
        globalThis.toastr?.success('Vocalia debug logging stopped.', MODULE_DISPLAY_NAME);
    });

    $('#av_debug_copy').on('click', async () => {
        try {
            await copyVocaliaDebugLogToClipboard();
            globalThis.toastr?.success('Vocalia debug log copied to clipboard.', MODULE_DISPLAY_NAME);
        } catch (error) {
            errorToast(`Failed to copy debug log: ${error?.message ?? error}`);
        }
    });

    $('#av_debug_download').on('click', () => {
        try {
            downloadVocaliaDebugLog();
            globalThis.toastr?.success('Vocalia debug log downloaded.', MODULE_DISPLAY_NAME);
        } catch (error) {
            errorToast(`Failed to download debug log: ${error?.message ?? error}`);
        }
    });

    $('#av_debug_clear').on('click', () => {
        clearVocaliaDebugLog();
        globalThis.toastr?.success('Vocalia debug log cleared.', MODULE_DISPLAY_NAME);
    });

    $('#av_sync_state').on('click', async () => {
        if (!getCurrentGroup()) {
            globalThis.toastr?.warning('Open a group chat first.', MODULE_DISPLAY_NAME);
            return;
        }

        logVocaliaEvent('diagnostics.sync_state_clicked');

        getChatState().groupId = null;
        ensureStateForCurrentGroup();
        updateExtensionPrompt();
        updateDiagnosticsPanel();
        await saveMetadata();

        globalThis.toastr?.success('Scene state synced from current group.', MODULE_DISPLAY_NAME);
    });

    $('#av_render_now').on('click', () => applyOverlaySettingToVisibleMessages());

    $('#av_dump_state').on('click', () => {
        console.log(`[${MODULE_DISPLAY_NAME}] state`, clone(getChatState()));
        console.log(`[${MODULE_DISPLAY_NAME}] settings`, clone(getSettings()));
        console.log(`[${MODULE_DISPLAY_NAME}] debug bundle`, buildVocaliaDebugBundle());
        globalThis.toastr?.info('Vocalia state logged to console.', MODULE_DISPLAY_NAME);
    });

    $('#av_reset_extension').on('click', async () => {
        await resetVocaliaExtension();
    });

    bindProtocolInjectionEditorUi();
    loadSettingsUi();
}

// ============================================================================
// Section 21. Event Binding
// ============================================================================
// Purpose:
// - Register extension handlers with SillyTavern eventSource.
// - Observe chat DOM changes for overlay rendering.
// - Keep event binding separate from runtime enable/disable.
// - Bind only true stop/abort lifecycle events to waiter interruption cleanup.
// - Treat GENERATION_ENDED as observational only; it may fire before or near
//   MESSAGE_RECEIVED and must not clear Vocalia waiters.
// - Do not bind GENERATION_AFTER_COMMANDS to waiter cleanup; it is not a
//   generation-finished/no-message signal.
// ============================================================================

function bindEvent(eventSource, eventTypes, eventName, handler) {
    const eventType = eventTypes?.[eventName];

    if (!eventType) {
        warn(`SillyTavern event type unavailable: ${eventName}`);
        return;
    }

    if (typeof eventSource.on === 'function') {
        eventSource.on(eventType, handler);
        return;
    }

    throw new Error('SillyTavern eventSource does not expose an .on() method.');
}

function bindOptionalEvent(eventSource, eventTypes, eventName, handler) {
    const eventType = eventTypes?.[eventName];

    if (!eventType) {
        logVocaliaEvent('event.optional_unavailable', {
            eventName,
        });
        return false;
    }

    if (typeof eventSource.on === 'function') {
        eventSource.on(eventType, handler);
        return true;
    }

    throw new Error('SillyTavern eventSource does not expose an .on() method.');
}

function bindEvents() {
    const context = ctx();
    const eventSource = context.eventSource;
    const eventTypes = context.eventTypes ?? context.event_types;

    if (!eventSource || !eventTypes) {
        throw new Error('SillyTavern eventSource/eventTypes unavailable.');
    }

    bindEvent(eventSource, eventTypes, 'MESSAGE_SENT', handleUserMessage);
    bindEvent(eventSource, eventTypes, 'MESSAGE_RECEIVED', handleMessageReceived);
    bindEvent(eventSource, eventTypes, 'CHARACTER_MESSAGE_RENDERED', handleMessageRendered);
    bindEvent(eventSource, eventTypes, 'CHAT_CHANGED', handleChatChanged);
    bindEvent(eventSource, eventTypes, 'GROUP_UPDATED', handleGroupUpdated);

    bindOptionalEvent(eventSource, eventTypes, 'GENERATION_STOPPED', handleGenerationLifecycleStopped);

    // GENERATION_ENDED is useful for diagnostics and harmless tail checks, but
    // it must not resolve pending waiters as interrupted.
    bindOptionalEvent(eventSource, eventTypes, 'GENERATION_ENDED', handleGenerationLifecycleEnded);

    // Intentionally not bound:
    // - GENERATION_AFTER_COMMANDS: before/around generation command handling, not
    //   proof that generation failed or produced no message.
    // - Ordinary GENERATION_ENDED cleanup: handled above as observation only.

    if (mutationObserver) {
        mutationObserver.disconnect();
        mutationObserver = null;
    }

    mutationObserver = new MutationObserver(() => {
        renderAllVisibleOverlays();
        updateDiagnosticsPanel();
    });

    const chatElement = document.querySelector('#chat');
    if (chatElement) {
        mutationObserver.observe(chatElement, {
            childList: true,
            subtree: false,
        });
    }
}

// ============================================================================
// Section 22. Runtime Lifecycle
// ============================================================================
// Purpose:
// - Enable, disable, and initialize Aspect: Vocalia safely.
// - Install the send guard only while Vocalia is active.
// - Preserve one authoritative enableRuntime() and disableRuntime() definition.
// ============================================================================

async function enableRuntime() {
    ensureStateForCurrentGroup();

    installSendGuard();

    await forceManualStrategyForCurrentGroup();

    updateExtensionPrompt();
    applyOverlaySettingToVisibleMessages();
    updateDiagnosticsPanel();

    await saveMetadata();

    logVocaliaEvent('runtime.enabled', {
        groupId: ctx().groupId,
        sendGuardInstalled: vocaliaSendGuardInstalled,
    });
}

async function disableRuntime() {
    triggerQueue = [];
    queueRunning = false;

    uninstallSendGuard();

    if (getSettings().restoreOriginalStrategyOnDisable) {
        await restoreOriginalStrategyForCurrentGroup();
    }

    updateExtensionPrompt();
    restoreAllVisibleRawMessages();
    updateDiagnosticsPanel();

    await saveMetadata();

    logVocaliaEvent('runtime.disabled', {
        groupId: ctx().groupId,
        sendGuardInstalled: vocaliaSendGuardInstalled,
    });
}

export async function onEnable() {
    getSettings().enabled = true;
    saveSettings();
    await enableRuntime();
}

export async function onDisable() {
    getSettings().enabled = false;
    saveSettings();
    await disableRuntime();
}

async function init() {
    if (initialized) return;
    initialized = true;

    injectStyles();
    injectSettingsUi();
    bindEvents();

    ensureStateForCurrentGroup();
    updateExtensionPrompt();
    updateDiagnosticsPanel();

    if (getSettings().enabled) {
        await enableRuntime();
    } else {
        uninstallSendGuard();
    }

    debug('Initialized.');
}

jQuery(async () => {
    try {
        await init();
    } catch (error) {
        console.error(`[${MODULE_DISPLAY_NAME}] Initialization failed.`, error);
        errorToast(error?.message ?? error);
    }
});