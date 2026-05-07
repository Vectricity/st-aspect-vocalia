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
    useSlashTrigger: true,
    fallbackToInternalGenerate: true,

    maxTriggersPerMessage: 2,
    maxChainReplies: 8,
    triggerDelayMs: 350,
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
    version: 9,
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

    triggeredThisTurn: [],

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

function migrateRenamedSettings(settings) {
    migrateInvertedBooleanSetting(settings, 'showCharacterLabels', 'hideCharacterNameInRefinedMessage');
    migrateInvertedBooleanSetting(settings, 'showThoughts', 'hideThoughtsInRefinedMessage');
    migrateInvertedBooleanSetting(settings, 'showDebugToasts', 'hideDebugToasts');

    return settings;
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
        useSlashTrigger: settings.useSlashTrigger,
        fallbackToInternalGenerate: settings.fallbackToInternalGenerate,
        maxTriggersPerMessage: settings.maxTriggersPerMessage,
        maxChainReplies: settings.maxChainReplies,
        triggerDelayMs: settings.triggerDelayMs,
        triggerMessageTimeoutMs: getTriggerMessageTimeoutMs(),
        arrivalApplyMode: settings.arrivalApplyMode,
        firstMessageFallback: settings.firstMessageFallback,
        triggerNamedCharacterOnFirstUserMessage: settings.triggerNamedCharacterOnFirstUserMessage,
        renderOverlay: settings.renderOverlay,
        quoteDialogue: settings.quoteDialogue,
        actionDisplayStyle: settings.actionDisplayStyle,
        narrationDisplayStyle: settings.narrationDisplayStyle,
        thoughtsDisplayStyle: settings.thoughtsDisplayStyle,
        promptDepth: settings.promptDepth,
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
// Section 6. Opening, Existing-Chat, Empty-Send, User-Summon, and User-Departure Selection
// ============================================================================
// Purpose:
// - Bootstrap empty chats without router metadata history.
// - Continue existing chats by selecting the most recent route-eligible prior
//   assistant speaker when Vocalia lacks a clean current-turn target.
// - Intercept empty Send continuation so SillyTavern Manual mode cannot choose
//   a random unmuted group member behind Vocalia's back.
// - Recover from user-only / unanswered-user-message chats by inspecting the
//   latest user message when empty Send is pressed.
// - Allow user-side summons/contact to bring absent members into route eligibility.
// - Use a constrained local alias-use classifier for absent-character bootstrap:
//   exact alias + interaction signal = present/remote;
//   exact alias + reference-only signal = no summon.
// - Allow user-side scene departure to move present members to absent when the
//   user clearly changes active scene without taking those members along.
// - Treat "departing" as a routing state meaning "no longer present in the
//   active scene", not necessarily literal physical walking away.
// - Allow multiple explicitly relevant members to trigger in one user turn.
// - Never resurrect absent members through random/first fallback.
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
    return Math.max(1, Number(getSettings().maxTriggersPerMessage) || 1);
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

function normalizeClassifierToken(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
        .toLocaleLowerCase();
}

function tokenizeForAliasClassifier(text) {
    const source = String(text ?? '');
    const tokens = [];
    const pattern = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu;

    for (const match of source.matchAll(pattern)) {
        const raw = match[0];
        const lower = normalizeClassifierToken(raw);
        if (!lower) continue;

        tokens.push({
            raw,
            lower,
            start: match.index,
            end: match.index + raw.length,
        });
    }

    return tokens;
}

function classifierTokenSet(values) {
    return new Set(values.map(normalizeClassifierToken).filter(Boolean));
}

function tokenInCategory(token, category) {
    if (!token) return false;
    return category.has(token.lower);
}

function anyTokenInCategory(tokens, category) {
    return tokens.some(token => tokenInCategory(token, category));
}

function findTokenSubsequence(tokens, searchTokens) {
    if (!tokens.length || !searchTokens.length || searchTokens.length > tokens.length) return -1;

    const haystack = tokens.map(token => typeof token === 'string' ? token : token.lower);
    const needle = searchTokens.map(token => typeof token === 'string' ? token : token.lower);

    for (let i = 0; i <= haystack.length - needle.length; i += 1) {
        let matched = true;

        for (let j = 0; j < needle.length; j += 1) {
            if (haystack[i + j] !== needle[j]) {
                matched = false;
                break;
            }
        }

        if (matched) return i;
    }

    return -1;
}

function findAliasClassifierSpans(sourceTokens, alias) {
    const aliasTokens = tokenizeForAliasClassifier(alias);
    if (!sourceTokens.length || !aliasTokens.length) return [];

    const aliasLowers = aliasTokens.map(token => token.lower);
    const spans = [];

    for (let i = 0; i <= sourceTokens.length - aliasLowers.length; i += 1) {
        let matched = true;

        for (let j = 0; j < aliasLowers.length; j += 1) {
            if (sourceTokens[i + j].lower !== aliasLowers[j]) {
                matched = false;
                break;
            }
        }

        if (!matched) continue;

        spans.push({
            alias,
            aliasTokens: aliasLowers,
            startIndex: i,
            endIndex: i + aliasLowers.length,
            charStart: sourceTokens[i].start,
            charEnd: sourceTokens[i + aliasLowers.length - 1].end,
        });
    }

    return spans;
}

function tokenWindowAroundSpan(tokens, span, radius = 8) {
    return tokens.slice(
        Math.max(0, span.startIndex - radius),
        Math.min(tokens.length, span.endIndex + radius),
    );
}

function tokensBeforeSpan(tokens, span, radius = 8) {
    return tokens.slice(Math.max(0, span.startIndex - radius), span.startIndex);
}

function tokensAfterSpan(tokens, span, radius = 8) {
    return tokens.slice(span.endIndex, Math.min(tokens.length, span.endIndex + radius));
}

function aliasHasPossessiveMarker(source, span) {
    return /^['’]s\b/iu.test(String(source ?? '').slice(span.charEnd, span.charEnd + 3));
}

function getClassifierClauseText(source, span) {
    const text = String(source ?? '');
    const before = text.slice(0, span.charStart);
    const after = text.slice(span.charEnd);

    const leftBoundaries = [
        before.lastIndexOf('.'),
        before.lastIndexOf('!'),
        before.lastIndexOf('?'),
        before.lastIndexOf('。'),
        before.lastIndexOf('！'),
        before.lastIndexOf('？'),
        before.lastIndexOf('\n'),
    ];

    const left = Math.max(...leftBoundaries) + 1;

    const rightCandidates = ['.', '!', '?', '。', '！', '？', '\n']
        .map(boundary => after.indexOf(boundary))
        .filter(index => index >= 0);

    const right = rightCandidates.length
        ? span.charEnd + Math.min(...rightCandidates)
        : text.length;

    return text.slice(left, right).trim();
}

function getClassifierClauseTokens(source, span) {
    return tokenizeForAliasClassifier(getClassifierClauseText(source, span));
}

function getRawTextAfterSpan(source, span, length = 8) {
    return String(source ?? '').slice(span.charEnd, span.charEnd + length);
}

function getRawTextBeforeSpan(source, span, length = 8) {
    return String(source ?? '').slice(Math.max(0, span.charStart - length), span.charStart);
}

function hasPunctuationAddressMarker(source, span) {
    const before = getRawTextBeforeSpan(source, span, 4);
    const after = getRawTextAfterSpan(source, span, 4);

    return (
        /(?:^|[\s"'“‘([{])$/u.test(before)
        && /^\s*[,.:;?!！？，。]/u.test(after)
    );
}

function aliasStartsOrEndsShortClause(source, span, maxExtraTokens = 3) {
    const clauseTokens = getClassifierClauseTokens(source, span);
    if (!clauseTokens.length) return false;

    const aliasTokens = span.aliasTokens;
    const aliasOffset = findTokenSubsequence(clauseTokens, aliasTokens);
    if (aliasOffset < 0) return false;

    const extraCount = clauseTokens.length - aliasTokens.length;
    if (extraCount > maxExtraTokens) return false;

    const atStart = aliasOffset === 0;
    const atEnd = aliasOffset + aliasTokens.length === clauseTokens.length;

    return atStart || atEnd;
}

function hasUserSubjectNear(tokens) {
    const userAliases = getUserSceneAliases()
        .flatMap(alias => tokenizeForAliasClassifier(alias).map(token => token.lower))
        .filter(Boolean);

    const userAliasSet = new Set([
        ...userAliases,
        'i',
        'me',
        'my',
        'myself',
        'we',
        'us',
        'our',
    ]);

    return tokens.some(token => userAliasSet.has(token.lower));
}

function hasReferenceOnlySignal(source, tokens, span) {
    if (aliasHasPossessiveMarker(source, span)) return true;

    const clauseTokens = getClassifierClauseTokens(source, span);
    const window = tokenWindowAroundSpan(tokens, span, 7);

    const referenceTerms = classifierTokenSet([
        'wonder',
        'wondering',
        'remember',
        'remembered',
        'recall',
        'recalled',
        'think',
        'thinking',
        'thought',
        'hope',
        'hoping',
        'wish',
        'wishing',
        'imagine',
        'imagined',
        'dream',
        'dreamed',
        'dreamt',
        'miss',
        'missed',
        'heard',
        'told',
        'mentioned',
        'mention',
        'about',
        'memory',
        'memories',
        'rumor',
        'rumour',
        'story',
        'stories',
        'name',
        'notes',
    ]);

    if (anyTokenInCategory(clauseTokens, referenceTerms)) {
        return true;
    }

    return anyTokenInCategory(window, referenceTerms)
        && !hasPunctuationAddressMarker(source, span)
        && !aliasStartsOrEndsShortClause(source, span, 2);
}

function isDirectAddressAliasUse(source, tokens, span) {
    if (aliasHasPossessiveMarker(source, span)) return false;

    const clauseTokens = getClassifierClauseTokens(source, span);
    if (!clauseTokens.length) return false;

    const addressFillers = classifierTokenSet([
        'oh',
        'ah',
        'uh',
        'um',
        'hey',
        'hi',
        'hello',
        'please',
        'wait',
        'yo',
    ]);

    const aliasOffset = findTokenSubsequence(clauseTokens, span.aliasTokens);
    if (aliasOffset < 0) return false;

    const before = clauseTokens.slice(0, aliasOffset);
    const after = clauseTokens.slice(aliasOffset + span.aliasTokens.length);

    const onlyAddressFillersBefore = before.every(token => tokenInCategory(token, addressFillers));
    const onlyAddressFillersAfter = after.every(token => tokenInCategory(token, addressFillers));

    if (hasPunctuationAddressMarker(source, span) && before.length <= 2 && onlyAddressFillersBefore) {
        return true;
    }

    if (aliasStartsOrEndsShortClause(source, span, 3) && onlyAddressFillersBefore && onlyAddressFillersAfter) {
        return true;
    }

    const quoteBefore = /["“‘']\s*$/u.test(getRawTextBeforeSpan(source, span, 4));
    const quoteAfter = /^\s*["”’']/u.test(getRawTextAfterSpan(source, span, 4));

    if ((quoteBefore || quoteAfter) && aliasStartsOrEndsShortClause(source, span, 4)) {
        return !hasReferenceOnlySignal(source, tokens, span);
    }

    return false;
}

function isRemoteAliasUse(source, tokens, span) {
    if (aliasHasPossessiveMarker(source, span)) return false;

    const window = tokenWindowAroundSpan(tokens, span, 10);

    const remoteChannels = classifierTokenSet([
        'phone',
        'radio',
        'text',
        'dm',
        'message',
        'messages',
        'call',
        'calls',
        'comms',
        'comm',
        'video',
        'facetime',
        'intercom',
        'walkie',
        'transceiver',
        'wireless',
    ]);

    const remoteContactActions = classifierTokenSet([
        'call',
        'called',
        'calling',
        'phone',
        'phoned',
        'text',
        'texted',
        'message',
        'messaged',
        'dm',
        'radio',
        'radioed',
        'hail',
        'hailed',
        'signal',
        'signaled',
        'signalled',
        'contact',
        'contacted',
        'reach',
        'reached',
    ]);

    if (!anyTokenInCategory(window, remoteChannels)) return false;
    if (hasReferenceOnlySignal(source, tokens, span) && !anyTokenInCategory(window, remoteContactActions)) return false;

    return anyTokenInCategory(window, remoteContactActions)
        || isDirectAddressAliasUse(source, tokens, span)
        || hasUserSubjectNear(window);
}

function isExplicitSummonAliasUse(source, tokens, span) {
    if (aliasHasPossessiveMarker(source, span)) return false;

    const window = tokenWindowAroundSpan(tokens, span, 9);

    const summonActions = classifierTokenSet([
        'call',
        'called',
        'calling',
        'shout',
        'shouted',
        'shouting',
        'yell',
        'yelled',
        'yelling',
        'cry',
        'cried',
        'holler',
        'hollered',
        'summon',
        'summoned',
        'summoning',
        'beckon',
        'beckoned',
        'wave',
        'waved',
        'gesture',
        'gestured',
        'fetch',
        'fetched',
        'bring',
        'brought',
        'get',
        'got',
        'hail',
        'hailed',
        'signal',
        'signaled',
        'signalled',
    ]);

    if (!anyTokenInCategory(window, summonActions)) return false;
    if (hasReferenceOnlySignal(source, tokens, span) && !hasUserSubjectNear(window)) return false;

    return true;
}

function isPhysicalEncounterOrPerceptionAliasUse(source, tokens, span) {
    if (aliasHasPossessiveMarker(source, span)) return false;

    const window = tokenWindowAroundSpan(tokens, span, 10);
    const before = tokensBeforeSpan(tokens, span, 8);
    const after = tokensAfterSpan(tokens, span, 8);

    const perceptionActions = classifierTokenSet([
        'see',
        'saw',
        'seen',
        'spot',
        'spotted',
        'notice',
        'noticed',
        'find',
        'found',
        'locate',
        'located',
        'discover',
        'discovered',
        'meet',
        'met',
        'encounter',
        'encountered',
    ]);

    const contactActions = classifierTokenSet([
        'bump',
        'bumped',
        'run',
        'ran',
        'walk',
        'walked',
        'walking',
        'slam',
        'slammed',
        'crash',
        'crashed',
        'collide',
        'collided',
        'stumble',
        'stumbled',
        'trip',
        'tripped',
        'step',
        'stepped',
    ]);

    const movementActions = classifierTokenSet([
        'go',
        'went',
        'head',
        'headed',
        'move',
        'moved',
        'walk',
        'walked',
        'walking',
        'run',
        'ran',
        'turn',
        'turned',
        'round',
        'rounded',
        'enter',
        'entered',
        'come',
        'came',
        'cross',
        'crossed',
    ]);

    const contactConnectors = classifierTokenSet([
        'into',
        'against',
        'with',
        'across',
        'upon',
        'toward',
        'towards',
        'near',
        'beside',
        'by',
    ]);

    const arrivalStateTerms = classifierTokenSet([
        'arrive',
        'arrived',
        'arrives',
        'enter',
        'entered',
        'enters',
        'appear',
        'appeared',
        'appears',
        'there',
        'nearby',
        'ahead',
        'beside',
        'front',
        'behind',
    ]);

    if (anyTokenInCategory(before, perceptionActions) && hasUserSubjectNear(window)) {
        return !hasReferenceOnlySignal(source, tokens, span);
    }

    if (anyTokenInCategory(window, contactActions) && anyTokenInCategory(window, contactConnectors) && hasUserSubjectNear(window)) {
        return !hasReferenceOnlySignal(source, tokens, span);
    }

    if (anyTokenInCategory(before, movementActions) && anyTokenInCategory(before, contactConnectors) && hasUserSubjectNear(window)) {
        return !hasReferenceOnlySignal(source, tokens, span);
    }

    if (anyTokenInCategory(after, arrivalStateTerms) || anyTokenInCategory(before, arrivalStateTerms)) {
        return !hasReferenceOnlySignal(source, tokens, span);
    }

    return false;
}

function classifyAbsentAliasUse(text, alias) {
    const source = String(text ?? '');
    const tokens = tokenizeForAliasClassifier(source);
    const spans = findAliasClassifierSpans(tokens, alias);

    if (!spans.length) {
        return null;
    }

    const rejected = [];

    for (const span of spans) {
        if (isRemoteAliasUse(source, tokens, span)) {
            return {
                type: MEMBER_STATUS_REMOTE,
                alias,
                reason: 'remote_channel_contact',
                span: {
                    charStart: span.charStart,
                    charEnd: span.charEnd,
                },
            };
        }

        if (isDirectAddressAliasUse(source, tokens, span)) {
            return {
                type: MEMBER_STATUS_PRESENT,
                alias,
                reason: 'direct_name_address',
                span: {
                    charStart: span.charStart,
                    charEnd: span.charEnd,
                },
            };
        }

        if (isPhysicalEncounterOrPerceptionAliasUse(source, tokens, span)) {
            return {
                type: MEMBER_STATUS_PRESENT,
                alias,
                reason: 'physical_encounter_or_perception',
                span: {
                    charStart: span.charStart,
                    charEnd: span.charEnd,
                },
            };
        }

        if (isExplicitSummonAliasUse(source, tokens, span)) {
            return {
                type: MEMBER_STATUS_PRESENT,
                alias,
                reason: 'explicit_summon_or_call',
                span: {
                    charStart: span.charStart,
                    charEnd: span.charEnd,
                },
            };
        }

        rejected.push({
            alias,
            charStart: span.charStart,
            charEnd: span.charEnd,
            reason: hasReferenceOnlySignal(source, tokens, span)
                ? 'reference_only'
                : 'alias_without_interaction_signal',
        });
    }

    return {
        type: null,
        alias,
        reason: 'no_bootstrap_contact',
        rejected,
    };
}

function isRemoteContactForAlias(text, alias) {
    return classifyAbsentAliasUse(text, alias)?.type === MEMBER_STATUS_REMOTE;
}

function isPhysicalSummonForAlias(text, alias) {
    return classifyAbsentAliasUse(text, alias)?.type === MEMBER_STATUS_PRESENT;
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

function buildMovementVerbPattern() {
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

function userHasSingularMovementClause(text) {
    const source = String(text ?? '');
    const userSubject = getUserSubjectPattern();
    const movementVerb = buildMovementVerbPattern();
    const transitionMarker = buildSceneTransitionMarkerPattern();

    const patterns = [
        new RegExp(`\\b${userSubject}\\b[\\s\\S]{0,180}\\b(?:${movementVerb})\\b[\\s\\S]{0,140}\\b(?:${transitionMarker})\\b`, 'iu'),
        new RegExp(`\\b${userSubject}\\b[\\s\\S]{0,80}\\b(?:then|and|before|after|as)\\b[\\s\\S]{0,120}\\b(?:${movementVerb})\\b[\\s\\S]{0,140}\\b(?:${transitionMarker})\\b`, 'iu'),
        new RegExp(`\\b${userSubject}\\b[\\s\\S]{0,120}\\b(?:leave|depart|exit|disappear|vanish)\\b`, 'iu'),
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

function userClearlyLeavesCurrentPlaceAlone(text, candidates = getPresentDepartureCandidates()) {
    const source = String(text ?? '');

    if (!userHasSingularMovementClause(source)) return false;
    if (isGroupInclusiveMovement(source)) return false;

    const accompanying = getMembersAccompanyingUser(source, candidates);
    return accompanying.length < candidates.length;
}

function detectUserDepartureBootstrap(text) {
    const source = String(text ?? '');
    const candidates = getPresentDepartureCandidates();
    const departed = [];
    const evidence = [];

    const aliasEntries = buildMentionAliasEntries(candidates);

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
                reason: 'user_changed_active_scene_alone_member_left_behind',
            });
        }
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
    const rejected = [];

    const remoteAvatars = new Set();
    const physicalAvatars = new Set();

    for (const entry of aliasEntries) {
        const member = entry.member;
        const alias = entry.alias;
        const classification = classifyAbsentAliasUse(source, alias);

        if (!classification) continue;

        if (classification.type === MEMBER_STATUS_REMOTE) {
            if (!remoteAvatars.has(member.avatar)) {
                remote.push(member);
                remoteAvatars.add(member.avatar);
            }

            evidence.push({
                type: MEMBER_STATUS_REMOTE,
                member: memberDebugSummary(member),
                alias,
                reason: classification.reason,
                classifier: classification,
            });
            continue;
        }

        if (classification.type === MEMBER_STATUS_PRESENT) {
            if (!remoteAvatars.has(member.avatar) && !physicalAvatars.has(member.avatar)) {
                physical.push(member);
                physicalAvatars.add(member.avatar);
            }

            evidence.push({
                type: MEMBER_STATUS_PRESENT,
                member: memberDebugSummary(member),
                alias,
                reason: classification.reason,
                classifier: classification,
            });
            continue;
        }

        if (classification.rejected?.length) {
            rejected.push({
                member: memberDebugSummary(member),
                alias,
                rejected: classification.rejected,
            });
        }
    }

    logVocaliaEvent('user_summon.classifier', {
        source,
        candidates: candidates.map(memberDebugSummary),
        evidence,
        rejected,
    });

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

function getLatestUnansweredUserMessage() {
    const chat = ctx().chat ?? [];

    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (!message) continue;
        if (message.is_system) continue;

        if (message.is_user) {
            return {
                messageId: i,
                message,
                text: String(message.mes ?? ''),
            };
        }

        return null;
    }

    return null;
}

function selectTargetsForLatestUnansweredUserMessageRecovery() {
    const latest = getLatestUnansweredUserMessage();

    if (!latest) {
        return {
            hasLatestUserMessage: false,
            reason: 'empty-send-no-latest-unanswered-user-message',
            targets: [],
            sourceMessageId: Math.max(0, (ctx().chat?.length ?? 1) - 1),
        };
    }

    const state = ensureStateForCurrentGroup();
    state.lastUserMessageId = latest.messageId;
    state.assistantCountSinceUser = 0;

    logVocaliaEvent('empty_send.latest_user_recovery.start', {
        latestUserMessageId: latest.messageId,
        latestUserMessage: getMessageDebugSummary(latest.messageId),
    });

    applyUserDepartureBootstrap(latest.messageId, latest.text);

    awaitManualStateRefreshForRecovery();

    const assistantMessagesBefore = getAssistantMessagesBefore(latest.messageId);
    const isOpeningUserMessage = assistantMessagesBefore.length === 0;

    if (isOpeningUserMessage) {
        const openingTargets = selectFirstSpeakerForOpeningUserMessage(latest.messageId);

        logVocaliaEvent('empty_send.latest_user_recovery.opening_targets', {
            latestUserMessageId: latest.messageId,
            openingTargets: openingTargets.map(memberDebugSummary),
        });

        return {
            hasLatestUserMessage: true,
            reason: openingTargets.length
                ? 'empty-send-latest-user-opening-message'
                : 'empty-send-latest-user-opening-message-no-target',
            targets: openingTargets,
            sourceMessageId: latest.messageId,
        };
    }

    const continuation = selectContinuationTargetsForUserMessage(latest.messageId, state);

    logVocaliaEvent('empty_send.latest_user_recovery.continuation_targets', {
        latestUserMessageId: latest.messageId,
        reason: continuation.reason,
        targets: continuation.targets.map(memberDebugSummary),
    });

    return {
        hasLatestUserMessage: true,
        reason: continuation.targets.length
            ? `empty-send-latest-user-${continuation.reason}`
            : 'empty-send-latest-user-no-continuation-target',
        targets: continuation.targets,
        sourceMessageId: latest.messageId,
    };
}

function awaitManualStateRefreshForRecovery() {
    ensureStateForCurrentGroup();
    updateExtensionPrompt();
    updateDiagnosticsPanel();
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

    const latestUserRecovery = selectTargetsForLatestUnansweredUserMessageRecovery();

    if (latestUserRecovery.hasLatestUserMessage) {
        logVocaliaEvent('empty_send.select.latest_user_recovery_result', {
            reason: latestUserRecovery.reason,
            sourceMessageId: latestUserRecovery.sourceMessageId,
            targets: latestUserRecovery.targets.map(memberDebugSummary),
        });

        return latestUserRecovery;
    }

    const storedTargets = limitTriggerTargets(getStoredSpeakingToTargetsFromLastSpeaker());
    if (storedTargets.length) {
        logVocaliaEvent('empty_send.select.result', {
            strategy: 'last-speaker-stored-speaking-to-targets',
            selected: storedTargets.map(memberDebugSummary),
        });

        return {
            reason: 'empty-send-stored-speaking-to-targets',
            targets: storedTargets,
            sourceMessageId: Math.max(0, (ctx().chat?.length ?? 1) - 1),
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
                sourceMessageId: Math.max(0, (ctx().chat?.length ?? 1) - 1),
            };
        }
    }

    const priorAssistant = findMostRecentRouteEligibleAssistantBefore(getCurrentChatTailMessageId());
    if (priorAssistant?.member) {
        return {
            reason: 'empty-send-most-recent-route-eligible-prior-assistant',
            targets: [priorAssistant.member],
            sourceMessageId: priorAssistant.messageId,
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
                sourceMessageId: Math.max(0, (ctx().chat?.length ?? 1) - 1),
            };
        }
    }

    const eligibleMembers = getRouteEligibleMembersCompat();

    if (eligibleMembers.length === 1) {
        return {
            reason: 'empty-send-sole-route-eligible-member',
            targets: [eligibleMembers[0]],
            sourceMessageId: Math.max(0, (ctx().chat?.length ?? 1) - 1),
        };
    }

    if (settings.firstMessageFallback === FIRST_MESSAGE_FALLBACK_RANDOM_PRESENT && eligibleMembers.length) {
        const randomMember = randomItem(eligibleMembers);
        return {
            reason: 'empty-send-random-route-eligible-fallback',
            targets: randomMember ? [randomMember] : [],
            sourceMessageId: Math.max(0, (ctx().chat?.length ?? 1) - 1),
        };
    }

    if (settings.firstMessageFallback === FIRST_MESSAGE_FALLBACK_FIRST_PRESENT && eligibleMembers.length) {
        return {
            reason: 'empty-send-first-route-eligible-fallback',
            targets: eligibleMembers.slice(0, 1),
            sourceMessageId: Math.max(0, (ctx().chat?.length ?? 1) - 1),
        };
    }

    return {
        reason: 'empty-send-no-continuation-target',
        targets: [],
        sourceMessageId: Math.max(0, (ctx().chat?.length ?? 1) - 1),
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
// Section 7. Group Reply Strategy Management
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
// Section 8. Router Protocol Prompt Injection
// ============================================================================
// Purpose:
// - Instruct the active group member to output one canonical structured block.
// - Allow ordered semantic content segments: dialogue, actions, narration, thoughts.
// - Keep physical arrivals separate from remote participation.
// - Make routing metadata strict: exactly one parameters segment, no duplicate keys.
// - Make the LLM responsible for deciding whether purposeful arrivals speak.
// - Support multiple next speakers when more than one response makes sense.
// ============================================================================

function buildInstructionPrompt() {
    const group = getCurrentGroup();
    if (!group) return '';

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

    return [
        '[Aspect: Vocalia Group Speaker Router Protocol - mandatory]',
        `All group members: ${members.map(member => member.name).join(', ') || 'none'}`,
        `Physically PRESENT in scene: ${present.map(member => member.name).join(', ') || 'none'}`,
        hasRemoteSupport ? `REMOTE but actively reachable in scene: ${remote.map(member => member.name).join(', ') || 'none'}` : '',
        hasRemoteSupport
            ? `ABSENT from scene and not remotely connected: ${absent.map(member => member.name).join(', ') || 'none'}`
            : `ABSENT from scene: ${absent.map(member => member.name).join(', ') || 'none'}`,
        `Pending physical arrivals already declared: ${pendingNames}`,
        '',
        'You are generating as exactly one active group member. Output exactly one character block for the active speaker only.',
        'The active speaker must be physically PRESENT or REMOTE unless the user has just explicitly summoned/contacted them into the scene.',
        'Do not generate as an absent, non-remote character who has not been summoned/contacted.',
        'Never output blocks for multiple characters. Never place unwrapped prose before or after the block.',
        `The outer wrapper MUST be [${tagPrefix}1=Exact Active Speaker Name] and [end ${tagPrefix}1].`,
        'Wrong outer wrapper: [Mikasa Ackerman] ... [end Mikasa Ackerman]',
        `Correct outer wrapper: [${tagPrefix}1=Mikasa Ackerman] ... [end ${tagPrefix}1]`,
        '',
        'Inside the character block, compose the visible message from ordered semantic segments.',
        'You may use these visible-content segment tags multiple times and in any order:',
        '[dialogue]spoken words only; no actions, no narration, no thoughts[end dialogue]',
        '[actions]only the active speaker’s deliberate physical action, body movement, facial expression, posture, gesture, voice action, or object interaction[end actions]',
        '[narration]only non-speaker-specific scene description, environment, atmosphere, timing, crowd reaction, consequences, or details not physically performed by the active speaker[end narration]',
        '[thoughts]private/internal thought of the active speaker only[end thoughts]',
        '',
        'End every character block with exactly one parameters segment.',
        hasRemoteSupport
            ? '[parameters]speakingTo=ExactName|ExactName|user|none,participationNextTurn=speak|idle|departing,arriving=ExactName|ExactName|none,remote=ExactName|ExactName|none[end parameters]'
            : '[parameters]speakingTo=ExactName|ExactName|user|none,participationNextTurn=speak|idle|departing,arriving=ExactName|ExactName|none[end parameters]',
        '',
        'Hard parameter rules:',
        '- The [parameters] segment must appear exactly once.',
        '- Each parameter key must appear exactly once. Duplicate keys are forbidden and make the block invalid.',
        '- Forbidden: arriving=Mikasa Ackerman,arriving=none.',
        '- Forbidden: speakingTo=user,speakingTo=Mikasa Ackerman.',
        '- Required keys: speakingTo, participationNextTurn, arriving.',
        hasRemoteSupport ? '- Use remote=none when no remote contact is active.' : '',
        '- Never include both a real value and none for the same parameter key.',
        '',
        'Content rules:',
        '- [dialogue] contains only spoken words. Do not include action or narration inside [dialogue].',
        '- [actions] is strictly limited to the active speaker’s own physical behavior or voice action.',
        '- [narration] is required for environment, atmosphere, crowd response, timing, external consequences, or anything not directly performed by the active speaker.',
        '- [thoughts] contains only the active speaker’s private/internal thoughts.',
        '- Use multiple ordered segments when needed to preserve the desired final reading order.',
        '- Do not wrap [actions], [narration], or [thoughts] content in Markdown asterisks or underscores.',
        '- Do not add quote marks around [dialogue]; Aspect: Vocalia controls dialogue quote display in the overlay.',
        '- Never send an empty response. At least one visible segment must contain meaningful text.',
        '',
        'Physical arrival rules:',
        '- arriving=ExactName means an absent group member physically enters, physically joins, or becomes physically present in the scene.',
        '- If an absent group member is called, summoned, physically noticed, requested to join, or established as nearby and expected to physically join, set arriving=ExactName.',
        '- If the active speaker calls, shouts for, summons, or requests an absent group member and the scene does not explicitly establish that the call fails, do not use arriving=none for that group member.',
        '- Do not use arriving for mere mentions, memories, assumptions, or names appearing in dialogue unless the scene state actually changes to physical presence.',
        '- Do not use arriving for phone calls, radio calls, video calls, intercoms, text messages, or other remote communication.',
        '- arriving=ExactName only updates physical scene presence. It does not automatically make that character speak next.',
        '- If the arriving character is called over, summoned for a reason, expected to answer, expected to introduce themselves, or is the natural next beat, set speakingTo=ExactName and participationNextTurn=speak.',
        '- If the arriving character deliberately enters silently, stays in the background, watches, listens, or should not speak yet, use arriving=ExactName with participationNextTurn=idle and speakingTo=user|none as appropriate.',
        '',
        hasRemoteSupport ? 'Remote participation rules:' : '',
        hasRemoteSupport ? '- remote=ExactName means an absent group member becomes actively reachable through phone, radio, video call, intercom, text/DM, or another remote communication channel.' : '',
        hasRemoteSupport ? '- Use remote=ExactName when the active speaker initiates, answers, establishes, or continues a remote communication channel with that group member.' : '',
        hasRemoteSupport ? '- Remote group members are not physically present, but they may be valid next speakers if speakingTo names them and participationNextTurn=speak.' : '',
        hasRemoteSupport ? '- If a remote character should speak next, set speakingTo=ExactName and participationNextTurn=speak.' : '',
        hasRemoteSupport ? '- Do not use remote for a mere mention, memory, or speculation.' : '',
        '',
        'Multi-speaker routing rules:',
        '- Multiple group members may respond in one user turn when it makes scene sense.',
        '- To trigger multiple next speakers, set speakingTo=ExactName|ExactName and participationNextTurn=speak.',
        '- The order of names in speakingTo is the order Aspect: Vocalia should attempt to trigger them.',
        `- Do not name more than ${Math.max(1, Number(settings.maxTriggersPerMessage) || 1)} next speakers unless absolutely necessary.`,
        '- Each eligible group member still has only one automatic trigger allowance per user turn.',
        '',
        'Parameter behavior rules:',
        '- speakingTo names who should answer next. Use exact group member names separated by |, or user, or none.',
        '- speakingTo=user means the human/persona should answer next. Never use user to refer to a group member.',
        '- If a group member should answer next, use that group member’s exact name from the group member list, not user.',
        hasRemoteSupport
            ? '- participationNextTurn=speak means Aspect: Vocalia may trigger the named group member(s) in speakingTo if they are physically present or remote and have not already been triggered this user turn.'
            : '- participationNextTurn=speak means Aspect: Vocalia may trigger the named group member(s) in speakingTo if they are present and have not already been triggered this user turn.',
        '- participationNextTurn=idle means the active speaker is not proactively handing the floor to another assistant now. It does not prevent this character from answering the user later.',
        '- participationNextTurn=departing means the active speaker leaves the scene after this response and becomes absent.',
        '- Arrival declarations may appear in any valid assistant response when the scene state changes. Do not restrict arrivals to the first assistant response after a user message.',
        '- Do not use a separate departing= parameter. Owner departure is only participationNextTurn=departing.',
        '- Do not invent character names outside the group member list.',
        '- After each eligible character has spoken once, stop and wait for the user.',
        settings.strictPrompt ? '- Malformed tags or duplicate parameters break routing. Exact tags, exact names, and unique parameter keys are more important than prose style.' : '',
        '[End Aspect: Vocalia Group Speaker Router Protocol]',
    ].filter(Boolean).join('\n');
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
// Section 9. Structured Block Parsing
// ============================================================================
// Purpose:
// - Parse only canonical [character1=Name]...[end character1] blocks.
// - Reject malformed [Name]...[end Name] outer wrappers by returning no blocks.
// - Preserve ordered visible-content segments inside each character block.
// - Accept both [end tag] and [/tag] inner segment closers for robustness.
// - Treat duplicate parameter keys as malformed metadata, not as recoverable.
// ============================================================================

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

        // Store normalized canonical keys used by the rest of Vocalia.
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

        // Also preserve the original spelling for diagnostics/compatibility.
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

function parseOrderedSegments(body) {
    const segmentRegex = /\[(dialogue|actions|narration|thoughts|parameters)\]([\s\S]*?)(?:\[end \1\]|\[\/\1\])/gi;
    const segments = [];

    let match;
    while ((match = segmentRegex.exec(String(body ?? ''))) !== null) {
        const type = String(match[1] ?? '').trim().toLocaleLowerCase();
        const text = String(match[2] ?? '').trim();

        segments.push({
            type,
            text,
            raw: match[0],
            start: match.index,
            end: segmentRegex.lastIndex,
        });
    }

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
// Section 10. Display Overlay Rendering
// ============================================================================
// Purpose:
// - Preserve raw structured content in chat history.
// - Render parsed blocks as semantic HTML.
// - Respect ordered dialogue/actions/narration/thoughts segments.
// - Use SillyTavern's own messageFormatting() only as a leaf renderer for
//   explicit quote/asterisk-wrapped segment display.
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

function buildDialogueDisplayText(value) {
    const text = stripOneBalancedOuterQuotePair(value);
    if (!text) return '';

    return getSettings().quoteDialogue ? `"${text}"` : text;
}

function buildStyledSegmentDisplayText(value, displayStyle) {
    const text = normalizePlainSegmentText(value);
    if (!text) return '';

    switch (displayStyle) {
        case OVERLAY_STYLE_ASTERISKS:
            return `*${text}*`;

        case OVERLAY_STYLE_ITALIC:
        case OVERLAY_STYLE_PLAIN:
        default:
            return text;
    }
}

function shouldUseSillyTavernFormattingForSegment(segmentType, displayStyle) {
    if (segmentType === SEGMENT_DIALOGUE) {
        return !!getSettings().quoteDialogue;
    }

    return displayStyle === OVERLAY_STYLE_ASTERISKS;
}

function createOverlaySpan(className, text) {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    return span;
}

function createFormattedSegmentElement(className, displayText, message, messageId) {
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

    span.textContent = displayText;
    return span;
}

function appendSegmentElement(parent, segment, block, message, messageId) {
    const settings = getSettings();
    const rawText = normalizePlainSegmentText(segment.text);
    if (!rawText) return;

    const paragraph = document.createElement('div');
    paragraph.className = `aspect-vocalia-segment aspect-vocalia-segment-${segment.type}`;

    switch (segment.type) {
        case SEGMENT_DIALOGUE: {
            const displayText = buildDialogueDisplayText(rawText);
            if (!displayText) return;

            if (shouldUseSillyTavernFormattingForSegment(segment.type, null)) {
                paragraph.append(createFormattedSegmentElement('aspect-vocalia-dialogue', displayText, message, messageId));
            } else {
                paragraph.append(createOverlaySpan('aspect-vocalia-dialogue', displayText));
            }

            break;
        }

        case SEGMENT_ACTIONS: {
            const displayText = buildStyledSegmentDisplayText(rawText, settings.actionDisplayStyle);
            if (!displayText) return;

            paragraph.dataset.displayStyle = settings.actionDisplayStyle;

            if (shouldUseSillyTavernFormattingForSegment(segment.type, settings.actionDisplayStyle)) {
                paragraph.append(createFormattedSegmentElement('aspect-vocalia-actions', displayText, message, messageId));
            } else {
                paragraph.append(createOverlaySpan('aspect-vocalia-actions', displayText));
            }

            break;
        }

        case SEGMENT_NARRATION: {
            const displayText = buildStyledSegmentDisplayText(rawText, settings.narrationDisplayStyle);
            if (!displayText) return;

            paragraph.dataset.displayStyle = settings.narrationDisplayStyle;

            if (shouldUseSillyTavernFormattingForSegment(segment.type, settings.narrationDisplayStyle)) {
                paragraph.append(createFormattedSegmentElement('aspect-vocalia-narration', displayText, message, messageId));
            } else {
                paragraph.append(createOverlaySpan('aspect-vocalia-narration', displayText));
            }

            break;
        }

        case SEGMENT_THOUGHTS: {
            if (!settings.showThoughts) return;

            const displayText = buildStyledSegmentDisplayText(rawText, settings.thoughtsDisplayStyle);
            if (!displayText) return;

            paragraph.dataset.displayStyle = settings.thoughtsDisplayStyle;

            if (shouldUseSillyTavernFormattingForSegment(segment.type, settings.thoughtsDisplayStyle)) {
                paragraph.append(createFormattedSegmentElement('aspect-vocalia-thoughts', displayText, message, messageId));
            } else {
                paragraph.append(createOverlaySpan('aspect-vocalia-thoughts', displayText));
            }

            break;
        }

        case SEGMENT_PARAMETERS:
        default:
            return;
    }

    parent.append(paragraph);
}

function createBlockOverlayElement(block, message, messageId) {
    const settings = getSettings();
    const blockElement = document.createElement('div');
    blockElement.className = 'aspect-vocalia-block';

    if (settings.showCharacterLabels) {
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

function formatMessageForDisplay(message, text, messageId) {
    const context = ctx();

    if (typeof context.messageFormatting === 'function') {
        return context.messageFormatting(
            text,
            message.name,
            !!message.is_system,
            !!message.is_user,
            Number(messageId),
        );
    }

    return escapeHtml(text).replace(/\n/g, '<br>');
}

function restoreRawMessageDisplay(messageId) {
    const context = ctx();
    const id = Number(messageId);
    const message = context.chat?.[id];

    if (!message) return;

    const { messageElement, textElement, exists } = getMessageElementAndTextElement(id);
    if (!exists) return;

    try {
        textElement.html(formatMessageForDisplay(message, String(message.mes ?? ''), id));
    } catch (error) {
        warn('Failed to restore raw message display.', error);
        textElement.html(escapeHtml(message.mes ?? '').replace(/\n/g, '<br>'));
    }

    messageElement.removeAttr('data-aspect-vocalia-rendered');
    messageElement.removeAttr('data-gsr-rendered');
}

function restoreAllVisibleRawMessages() {
    $('#chat .mes').each((_index, element) => {
        const id = Number($(element).attr('mesid'));
        if (Number.isInteger(id)) restoreRawMessageDisplay(id);
    });
}

function renderMessageOverlay(messageId) {
    const settings = getSettings();
    const context = ctx();
    const id = Number(messageId);
    const message = context.chat?.[id];

    if (!message || message.is_user || message.is_system) return;

    if (!settings.enabled || !settings.renderOverlay) {
        restoreRawMessageDisplay(id);
        return;
    }

    const fragment = createStructuredOverlayFragment(message, id);
    if (fragment === null) return;

    const { messageElement, textElement, exists } = getMessageElementAndTextElement(id);
    if (!exists) return;

    try {
        textElement.empty();
        textElement[0].append(fragment);
        messageElement.attr('data-aspect-vocalia-rendered', 'true');
        messageElement.removeAttr('data-gsr-rendered');
    } catch (error) {
        warn('Failed to render semantic overlay.', error);
        restoreRawMessageDisplay(id);
    }
}

function renderAllVisibleOverlays() {
    if (!getSettings().enabled) return;

    $('#chat .mes').each((_index, element) => {
        const id = Number($(element).attr('mesid'));
        if (Number.isInteger(id)) renderMessageOverlay(id);
    });
}

function applyOverlaySettingToVisibleMessages() {
    if (getSettings().renderOverlay) {
        renderAllVisibleOverlays();
    } else {
        restoreAllVisibleRawMessages();
    }
}

// ============================================================================
// Section 11. Routing State Transitions
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
        state.assistantCountSinceUser = Number(state.assistantCountSinceUser || 0) + 1;
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
    state.assistantCountSinceUser = Number(state.assistantCountSinceUser || 0) + 1;

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
// Section 12. Trigger Execution
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
// Section 13. Trigger Queue and Chain Control
// ============================================================================
// Purpose:
// - Serialize group member triggers.
// - Enforce max chain length.
// - Enforce one automatic trigger allowance per assistant per user turn.
// - Wait for the triggered assistant's actual MESSAGE_RECEIVED before continuing.
// - Expose the active target avatar for the generate_interceptor.
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

function getTriggeredThisTurnSet() {
    const state = getChatState();
    state.triggeredThisTurn ??= [];
    state.triggeredThisTurn = [...new Set(state.triggeredThisTurn)];
    return new Set(state.triggeredThisTurn);
}

function hasTriggeredThisTurn(member) {
    if (!member) return true;
    return getTriggeredThisTurnSet().has(member.avatar);
}

function markTriggeredThisTurn(member) {
    if (!member) return;

    const state = getChatState();
    state.triggeredThisTurn ??= [];

    if (!state.triggeredThisTurn.includes(member.avatar)) {
        state.triggeredThisTurn.push(member.avatar);
    }

    state.triggeredThisTurn = [...new Set(state.triggeredThisTurn)];

    logVocaliaEvent('allowance.mark_spent', {
        member: memberDebugSummary(member),
        triggeredThisTurn: arrayDebugNames(state.triggeredThisTurn),
    });
}

function unmarkTriggeredThisTurn(memberOrAvatar, reason = 'unspecified') {
    const state = getChatState();
    const avatar = typeof memberOrAvatar === 'string' ? memberOrAvatar : memberOrAvatar?.avatar;

    if (!avatar) return;

    const before = [...(state.triggeredThisTurn ?? [])];
    state.triggeredThisTurn = before.filter(item => item !== avatar);

    logVocaliaEvent('allowance.mark_released', {
        avatar,
        name: avatarToDebugName(avatar),
        reason,
        before: arrayDebugNames(before),
        after: arrayDebugNames(state.triggeredThisTurn),
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
    const evaluations = [];

    const allowed = uniqueMembers(members).filter(member => {
        const reasons = [];

        if (!member) {
            reasons.push('missing_member');
        } else {
            if (!isRouteEligibleForQueue(member)) {
                reasons.push('not_present_or_remote');
            }

            if (hasTriggeredThisTurn(member)) {
                reasons.push('already_triggered_this_turn');
            }

            if (isAlreadyQueuedThisTurn(member)) {
                reasons.push('already_queued');
            }
        }

        const accepted = !!member && reasons.length === 0;

        evaluations.push({
            member: memberDebugSummary(member),
            accepted,
            reasons,
        });

        return accepted;
    });

    logVocaliaEvent('allowance.filter', {
        incoming: members.map(memberDebugSummary),
        evaluations,
        allowed: allowed.map(memberDebugSummary),
    });

    return allowed;
}

function enqueueTriggers(members, sourceMessageId, reason = 'metadata') {
    const settings = getSettings();
    const state = getChatState();
    const maxChain = Math.max(0, Number(settings.maxChainReplies) || 0);

    logVocaliaEvent('queue.enqueue.start', {
        sourceMessageId,
        reason,
        incomingMembers: members.map(memberDebugSummary),
        maxChain,
        currentChainCount: state.chainCount,
    });

    if (!members.length || maxChain <= 0) {
        logVocaliaEvent('queue.enqueue.refused', {
            sourceMessageId,
            reason,
            cause: !members.length ? 'no_members' : 'max_chain_zero',
        });

        maybeApplyDeferredArrivalsAtChainEnd();
        return;
    }

    const remaining = Math.max(0, maxChain - Number(state.chainCount || 0));
    if (remaining <= 0) {
        debugToast('Router chain limit reached; no further members triggered.');

        logVocaliaEvent('queue.enqueue.refused', {
            sourceMessageId,
            reason,
            cause: 'chain_limit_reached',
            maxChain,
            chainCount: state.chainCount,
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

    const limited = allowed.slice(0, remaining);
    for (const member of limited) {
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
        queued: limited.map(memberDebugSummary),
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

            if (hasTriggeredThisTurn(latestMember)) {
                debugToast(`${latestMember.name} was skipped because they already spoke this user turn.`);

                logVocaliaEvent('queue.item.skipped', {
                    reason: 'already_triggered_this_turn',
                    latestMember: memberDebugSummary(latestMember),
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
            getChatState().chainCount = Number(getChatState().chainCount || 0) + 1;
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
// Section 14. SillyTavern Event Handlers and Send / Native Generation Guard
// ============================================================================
// Purpose:
// - React to user messages, assistant messages, renders, chat changes, and group changes.
// - Intercept empty Send in group chats so SillyTavern Manual mode cannot pick
//   a random unmuted group member.
// - Intercept Regenerate and Continue before native group generation can choose
//   an absent/random member.
// - Regenerate uses SillyTavern-style safe tail deletion with deleteLastMessage(),
//   never /cut.
// - Tag each message with witness metadata.
// - Filter prompt-building chat history per active target via generate_interceptor.
// - Treat native/bypass output as display-only when unsafe.
// ============================================================================

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
    if (!message || !message.is_user) return [];

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
        textPreview: String(text ?? '').slice(0, 500),
        eligibleMembers: [],
        summonEvidence: summon.evidence,
        departureEvidence: departure.evidence,
    };
}

function shouldBlockCurrentTypedSend() {
    // Normal typed user messages must be allowed even when every group member
    // is absent. Vocalia can then record the user-only scene beat and simply
    // choose no assistant trigger.
    //
    // Empty Send is still intercepted separately by interceptEmptySendEvent()
    // because empty Send is the path that can invoke native random group generation.
    return null;
}

function blockTypedSendEvent(event, source) {
    const text = getCurrentComposerText();
    const reason = getNoResponderBlockReason(text);

    if (reason) {
        logVocaliaEvent('send.no_responder_allowed_user_only_turn', {
            source,
            reason,
        }, { force: true });
    }

    return false;
}

function stopNativeSendEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
}

function getClickableActionElement(target) {
    const element = target instanceof Element ? target : null;
    if (!element) return null;

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

function getRouteEligibleCandidateFromMessage(messageId) {
    const message = ctx().chat?.[Number(messageId)];

    if (!message || message.is_user || message.is_system) {
        return {
            messageId,
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
            messageId,
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
            messageId,
            message,
            member: ownerMember,
            source: 'structured_block_owner',
            ownerBlock,
            messageOwner,
            structuredOwner: ownerMember,
        };
    }

    return {
        messageId,
        message,
        member: null,
        source: 'no_route_eligible_message_or_structured_owner',
        ownerBlock,
        messageOwner,
        structuredOwner: ownerMember,
    };
}

function getControlledActionFallbackTarget(action, targetMessageId) {
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
            };
        }
    }

    const prior = findMostRecentRouteEligibleAssistantBefore(ctx().chat?.length ?? 0);

    if (prior?.member) {
        return {
            messageId: prior.messageId,
            message: prior.message,
            member: prior.member,
            source: 'prior_route_eligible_assistant',
            reason: `controlled-${action}-prior-route-eligible-assistant`,
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
        };
    }

    return {
        messageId: targetMessageId,
        message: ctx().chat?.[Number(targetMessageId)],
        member: null,
        source: 'no_controlled_action_target',
        reason: `controlled-${action}-no-target`,
    };
}

function resolveControlledGenerationTarget(action, clickedElement) {
    const explicitMessageId = getMessageIdFromDomElement(clickedElement);
    const targetMessageId = Number.isInteger(Number(explicitMessageId))
        ? Number(explicitMessageId)
        : findLastAssistantMessageId();

    const messageCandidate = getRouteEligibleCandidateFromMessage(targetMessageId);

    if (messageCandidate.member) {
        return {
            ...messageCandidate,
            action,
            reason: `controlled-${action}-${messageCandidate.source}`,
        };
    }

    const fallback = getControlledActionFallbackTarget(action, targetMessageId);

    return {
        ...fallback,
        action,
        reason: fallback.reason ?? `controlled-${action}-${fallback.source}`,
        ownerBlock: messageCandidate.ownerBlock ?? fallback.ownerBlock ?? null,
        rejectedMessageCandidate: {
            source: messageCandidate.source,
            messageOwner: memberDebugSummary(messageCandidate.messageOwner),
            structuredOwner: memberDebugSummary(messageCandidate.structuredOwner),
        },
    };
}

function getTailRegenerateDeleteWindow() {
    const chat = ctx().chat ?? [];
    const end = chat.length - 1;

    if (end < 0) return null;

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

        const currentGenerationId = currentLastMessage.extra?.gen_id ?? null;

        if ((window.generationId && currentGenerationId) && currentGenerationId !== window.generationId) {
            logVocaliaEvent('controlled_generation.tail_delete_stopped', {
                reason: 'generation_id_changed',
                currentLastId,
                currentGenerationId,
                expectedGenerationId: window.generationId,
                deleted,
                window,
            }, { force: true });

            break;
        }

        await importedDeleteLastMessage();
        deleted += 1;

        logVocaliaEvent('controlled_generation.tail_delete_one', {
            deleted,
            expectedCount: window.count,
            remainingChatLength: ctx().chat?.length ?? null,
        }, { force: true });
    }

    const success = deleted === window.count;

    logVocaliaEvent('controlled_generation.tail_delete_end', {
        success,
        deleted,
        expectedCount: window.count,
        beforeWindow: window,
        afterChatLength: ctx().chat?.length ?? null,
    }, { force: true });

    if (!success) {
        globalThis.toastr?.warning(
            'Vocalia regenerate stopped early to avoid deleting unsafe messages.',
            MODULE_DISPLAY_NAME,
        );
    }

    return success;
}

async function handleVocaliaEmptySendContinuation(source) {
    if (vocaliaEmptySendInProgress) {
        logVocaliaEvent('empty_send.ignored_already_in_progress', {
            source,
        });

        return;
    }

    if (queueRunning || hasPendingTriggerWaiters()) {
        logVocaliaEvent('empty_send.ignored_generation_pending', {
            source,
            queueRunning,
            pendingTriggerWaiters: getPendingTriggerWaiterDebugSnapshot(),
        }, { force: true });

        globalThis.toastr?.info(
            'A Vocalia-triggered reply is still pending. Wait for it to finish before continuing.',
            MODULE_DISPLAY_NAME,
        );

        return;
    }

    vocaliaEmptySendInProgress = true;

    try {
        const context = ctx();

        if (!getSettings().enabled || !context.groupId) {
            logVocaliaEvent('empty_send.ignored', {
                source,
                reason: !getSettings().enabled ? 'settings_disabled' : 'not_group_chat',
            });

            return;
        }

        ensureStateForCurrentGroup();
        await forceManualStrategyForCurrentGroup();

        const latest = getLatestUnansweredUserMessage?.();
        if (latest) {
            recordWitnessesForUserMessage(latest.messageId, 'empty_send_recovery_latest_user');
        }

        const state = getChatState();

        state.chainCount = 0;
        state.activeTurnStartedAt = Date.now();
        state.triggeredThisTurn = [];
        triggerQueue = [];

        updateExtensionPrompt();
        updateDiagnosticsPanel();

        const selection = selectTargetsForEmptySendContinuation();

        logVocaliaEvent('empty_send.continuation_targets', {
            source,
            reason: selection.reason,
            sourceMessageId: selection.sourceMessageId ?? null,
            targets: selection.targets.map(memberDebugSummary),
        });

        if (!selection.targets.length) {
            globalThis.toastr?.warning(
                'No eligible Vocalia continuation speaker found.',
                MODULE_DISPLAY_NAME,
            );

            await saveMetadata();
            updateDiagnosticsPanel();
            return;
        }

        const sourceMessageId = Number.isInteger(Number(selection.sourceMessageId))
            ? Number(selection.sourceMessageId)
            : Math.max(0, (context.chat?.length ?? 1) - 1);

        enqueueTriggers(selection.targets, sourceMessageId, selection.reason);

        await saveMetadata();
        updateDiagnosticsPanel();
    } catch (error) {
        warn('Empty Send continuation failed.', error);
        errorToast(`Vocalia empty-send continuation failed: ${error?.message ?? error}`);

        logVocaliaEvent('empty_send.error', {
            source,
            error,
        }, { force: true });
    } finally {
        vocaliaEmptySendInProgress = false;
    }
}

function interceptEmptySendEvent(event, source) {
    if (!getSettings().enabled || !ctx().groupId) return false;

    const text = getCurrentComposerText();
    if (!isBlankText(text)) return false;

    stopNativeSendEvent(event);

    logVocaliaEvent('empty_send.intercepted', {
        source,
        chatLength: ctx().chat?.length ?? null,
    }, { force: true });

    void handleVocaliaEmptySendContinuation(source);

    return true;
}

async function handleVocaliaControlledGeneration(action, clickedElement, source) {
    if (vocaliaControlledGenerationInProgress) {
        logVocaliaEvent('controlled_generation.ignored_already_in_progress', {
            action,
            source,
        }, { force: true });

        return;
    }

    if (queueRunning || hasPendingTriggerWaiters()) {
        logVocaliaEvent('controlled_generation.ignored_generation_pending', {
            action,
            source,
            queueRunning,
            pendingTriggerWaiters: getPendingTriggerWaiterDebugSnapshot(),
        }, { force: true });

        globalThis.toastr?.info(
            'A Vocalia-triggered reply is still pending. Wait for it to finish before using Regenerate or Continue.',
            MODULE_DISPLAY_NAME,
        );

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
        state.chainCount = 0;
        state.activeTurnStartedAt = Date.now();
        state.triggeredThisTurn = [];
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
                await saveMetadata();
                updateDiagnosticsPanel();
                return;
            }
        }

        enqueueTriggers([target.member], sourceMessageId, target.reason);

        await saveMetadata();
        updateDiagnosticsPanel();
    } catch (error) {
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
        chatLength: ctx().chat?.length ?? null,
        clickedElementText: getElementActionText(clickable).slice(0, 500),
        clickedMessageId: getMessageIdFromDomElement(clickable),
    }, { force: true });

    void handleVocaliaControlledGeneration(action, clickable, source);

    return true;
}

function handleSendClickCapture(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    if (interceptControlledGenerationEvent(event, 'document_click_capture')) return;

    const sendButton = target.closest('#send_but, .send_but');
    if (!sendButton) return;

    if (interceptEmptySendEvent(event, 'send_button_click')) return;

    // Typed user sends are allowed, even when no one is present.
    blockTypedSendEvent(event, 'send_button_click');
}

function handleSendSubmitCapture(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    if (!target.matches('#send_form, form')) return;
    if (!target.querySelector?.('#send_textarea')) return;

    if (interceptEmptySendEvent(event, 'send_form_submit')) return;

    // Typed user sends are allowed, even when no one is present.
    blockTypedSendEvent(event, 'send_form_submit');
}

function handleSendKeydownCapture(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const isComposer = target.matches('#send_textarea') || !!target.closest('#send_textarea');
    if (!isComposer) return;

    if (event.key !== 'Enter') return;
    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;

    if (interceptEmptySendEvent(event, 'composer_enter_key')) return;

    // Typed user sends are allowed, even when no one is present.
    blockTypedSendEvent(event, 'composer_enter_key');
}

function installSendGuard() {
    if (vocaliaSendGuardInstalled) return;

    document.addEventListener('click', handleSendClickCapture, true);
    document.addEventListener('submit', handleSendSubmitCapture, true);
    document.addEventListener('keydown', handleSendKeydownCapture, true);

    vocaliaSendGuardInstalled = true;

    logVocaliaEvent('send_guard.installed', {}, { force: false });
}

function uninstallSendGuard() {
    if (!vocaliaSendGuardInstalled) return;

    document.removeEventListener('click', handleSendClickCapture, true);
    document.removeEventListener('submit', handleSendSubmitCapture, true);
    document.removeEventListener('keydown', handleSendKeydownCapture, true);

    vocaliaSendGuardInstalled = false;
    vocaliaEmptySendInProgress = false;
    vocaliaControlledGenerationInProgress = false;

    logVocaliaEvent('send_guard.uninstalled', {}, { force: false });
}

function getWaitingForUserTarget(state) {
    if (!state.waitingForUserByAvatar) return null;

    const waitingMember = getMemberByAvatar(state.waitingForUserByAvatar);

    logVocaliaEvent('user_turn.continuation.waiting_candidate', {
        waitingForUserByAvatar: state.waitingForUserByAvatar,
        waitingMember: memberDebugSummary(waitingMember),
        eligible: isMemberInRouteEligibleList(waitingMember, getRouteEligibleMembersCompat()) && !waitingMember?.disabled,
    });

    if (waitingMember && !waitingMember.disabled && isMemberInRouteEligibleList(waitingMember, getRouteEligibleMembersCompat())) {
        return waitingMember;
    }

    return null;
}

function selectContinuationTargetsForUserMessage(userMessageId, state) {
    const userText = getMessageText(userMessageId);
    const selected = [];

    const namedEligibleMembers = findMentionedPresentMembers(userText);
    if (namedEligibleMembers.length) {
        logVocaliaEvent('user_turn.continuation.name_match', {
            userMessageId,
            userText,
            matchedMembers: namedEligibleMembers.map(memberDebugSummary),
        });

        selected.push(...namedEligibleMembers);
    }

    const summonedTargets = applyUserSummonBootstrap(userMessageId, userText);
    if (summonedTargets.length) {
        logVocaliaEvent('user_turn.continuation.user_summon_bootstrap', {
            userMessageId,
            userText,
            targets: summonedTargets.map(memberDebugSummary),
        });

        selected.push(...summonedTargets);
    }

    const explicitTargets = limitTriggerTargets(selected);
    if (explicitTargets.length) {
        return {
            reason: 'explicit-user-address-or-summon',
            targets: explicitTargets,
        };
    }

    const storedTargets = limitTriggerTargets(getStoredSpeakingToTargetsFromLastSpeaker());
    if (storedTargets.length) {
        return {
            reason: 'last-speaker-stored-speaking-to-targets',
            targets: storedTargets,
        };
    }

    const waitingMember = getWaitingForUserTarget(state);
    if (waitingMember) {
        return {
            reason: 'waiting-for-user',
            targets: [waitingMember],
        };
    }

    const priorAssistant = findMostRecentRouteEligibleAssistantBefore(userMessageId);
    if (priorAssistant?.member) {
        return {
            reason: 'most-recent-route-eligible-prior-assistant',
            targets: [priorAssistant.member],
        };
    }

    if (state.lastSpeakerAvatar) {
        const lastSpeaker = getMemberByAvatar(state.lastSpeakerAvatar);

        if (lastSpeaker && !lastSpeaker.disabled && isMemberInRouteEligibleList(lastSpeaker, getRouteEligibleMembersCompat())) {
            return {
                reason: 'last-route-eligible-speaker-continuation',
                targets: [lastSpeaker],
            };
        }
    }

    const latestEligibleMembers = getRouteEligibleMembersCompat();

    if (latestEligibleMembers.length === 1) {
        return {
            reason: 'sole-route-eligible-member-continuation',
            targets: [latestEligibleMembers[0]],
        };
    }

    if (getSettings().firstMessageFallback === FIRST_MESSAGE_FALLBACK_RANDOM_PRESENT && latestEligibleMembers.length) {
        const randomMember = randomItem(latestEligibleMembers);
        return {
            reason: 'random-route-eligible-continuation-fallback',
            targets: randomMember ? [randomMember] : [],
        };
    }

    if (getSettings().firstMessageFallback === FIRST_MESSAGE_FALLBACK_FIRST_PRESENT && latestEligibleMembers.length) {
        return {
            reason: 'first-route-eligible-continuation-fallback',
            targets: latestEligibleMembers.slice(0, 1),
        };
    }

    return {
        reason: 'no-continuation-target',
        targets: [],
    };
}

async function handleUserMessage(eventValue) {
    const settings = getSettings();

    logVocaliaEvent('event.MESSAGE_SENT.received', {
        rawEventValue: eventValue,
        settingsEnabled: settings.enabled,
        groupId: ctx().groupId,
    });

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

    recordWitnessesForUserMessage(userMessageId, 'message_sent_user');

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
    triggerQueue = [];

    applyUserDepartureBootstrap(userMessageId, userText);

    await forceManualStrategyForCurrentGroup();
    updateExtensionPrompt();
    updateDiagnosticsPanel();

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

function releaseBlankMessageState(messageId, message, correlatedAttempt) {
    const state = ensureStateForCurrentGroup();
    const member = getMemberByName(message?.name, getGroupMembers());
    const avatar = correlatedAttempt?.memberAvatar ?? member?.avatar ?? null;

    if (!avatar) return;

    unmarkTriggeredThisTurn(avatar, correlatedAttempt ? 'blank_message_correlated_to_trigger_attempt' : 'blank_message_from_member');

    if (state.waitingForUserByAvatar === avatar) {
        state.waitingForUserByAvatar = null;
    }

    if (state.lastSpeakerAvatar === avatar) {
        state.lastSpeakerAvatar = null;
    }

    if (state.members?.[avatar]) {
        state.members[avatar].lastStatus = MEMBER_STATUS_IDLE;
        state.members[avatar].speakingTo = [];
        state.members[avatar].lastBlankMessageId = messageId;
        state.members[avatar].lastBlankMessageAt = Date.now();
    }

    state.chainCount = Math.max(0, Number(state.chainCount || 0) - 1);

    scrubStaleRoutingReferences(state, getGroupMembers());

    logVocaliaEvent('assistant_message.blank_released_state', {
        messageId,
        releasedAvatar: avatar,
        releasedName: avatarToDebugName(avatar),
        correlatedAttempt: correlatedAttempt ?? null,
        adjustedChainCount: state.chainCount,
        waitingForUserByAvatar: state.waitingForUserByAvatar,
        lastSpeakerAvatar: state.lastSpeakerAvatar,
    });

    saveMetadata();
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
            : 'No recent Vocalia trigger attempt matched this blank message; stale state will still be scrubbed for this member.',
    });

    releaseBlankMessageState(messageId, message, correlatedAttempt);
    updateDiagnosticsPanel();
}

function shouldRefuseBypassRouting(message, ownerBlock, ownerMember, waiterResults) {
    if (waiterResults.length) {
        return {
            refused: false,
            reason: 'matched_vocalia_trigger_waiter',
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
        })),
    });

    if (!blocks.length) {
        recordWitnessesForAssistantMessage(messageId, message, null, null, 'assistant_message_unstructured');
        renderMessageOverlay(messageId);
        updateDiagnosticsPanel();
        await saveMetadata();
        return;
    }

    const firstAssistantForUserMessage = Number(getChatState().assistantCountSinceUser || 0) === 0;
    const ownerBlock = firstValidOwnerBlock(blocks, message);
    const ownerMember = getMemberByName(ownerBlock?.name, getGroupMembers());

    recordWitnessesForAssistantMessage(messageId, message, ownerBlock, ownerMember, 'assistant_message_structured');

    logVocaliaEvent('assistant_message.owner_resolved', {
        messageId,
        messageName: message.name,
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
        } : null,
        ownerMember: memberDebugSummary(ownerMember),
        waiterResults: waiterResults.map(result => ({
            status: result.status,
            attemptId: result.attempt?.id ?? null,
            memberName: result.attempt?.memberName ?? null,
        })),
    });

    const bypassDecision = shouldRefuseBypassRouting(message, ownerBlock, ownerMember, waiterResults);

    if (bypassDecision.refused) {
        renderMessageOverlay(messageId);
        warnBypassRoutingRefused(messageId, bypassDecision);
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

    if (!getSettings().enabled) return;

    ensureStateForCurrentGroup();
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
    await forceManualStrategyForCurrentGroup();
    updateExtensionPrompt();
    updateDiagnosticsPanel();
    await saveMetadata();

    logVocaliaEvent('event.GROUP_UPDATED.end');
}

// ============================================================================
// Section 15. Settings UI, Diagnostics, and Styling
// ============================================================================
// Purpose:
// - Build the Aspect: Vocalia extension drawer.
// - Bind drawer controls to persistent settings.
// - Display and manually edit active group member routing status.
// - Display per-turn trigger allowances for debugging.
// - Style semantic overlay nodes without using Markdown as the structure layer.
// - Allow selected segments to opt into SillyTavern's own quote/asterisk styling.
// - Provide start/stop/copy/download debug logging.
// ============================================================================

function injectStyles() {
    if (styleElement) return;

    styleElement = document.createElement('style');
    styleElement.id = 'aspect_vocalia_styles';
    styleElement.textContent = `
        #aspect_vocalia_settings small {
            opacity: 0.8;
            line-height: 1.35;
        }

        #aspect_vocalia_settings input[type="number"] {
            max-width: 8em;
        }

        #aspect_vocalia_settings select {
            max-width: 18em;
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

        #aspect_vocalia_member_state_table .aspect-vocalia-member-name {
            font-weight: 600;
        }

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

        .aspect-vocalia-array-list code {
            white-space: normal;
            word-break: break-word;
        }

        #chat .mes[data-aspect-vocalia-rendered="true"] .mes_text {
            display: block;
        }

        .aspect-vocalia-block {
            display: flex;
            flex-direction: column;
            gap: 0.45em;
        }

        .aspect-vocalia-block + .aspect-vocalia-block {
            margin-top: 0.75em;
        }

        .aspect-vocalia-character-label {
            font-weight: 700;
        }

        .aspect-vocalia-segment {
            white-space: pre-wrap;
        }

        .aspect-vocalia-segment-dialogue {
            font-style: normal;
        }

        .aspect-vocalia-segment-actions[data-display-style="${OVERLAY_STYLE_ITALIC}"],
        .aspect-vocalia-segment-narration[data-display-style="${OVERLAY_STYLE_ITALIC}"],
        .aspect-vocalia-segment-thoughts[data-display-style="${OVERLAY_STYLE_ITALIC}"] {
            font-style: italic;
        }

        .aspect-vocalia-segment-thoughts {
            opacity: 0.92;
        }

        .aspect-vocalia-formatted {
            display: inline;
        }

        .aspect-vocalia-formatted p {
            display: inline;
            margin: 0;
            padding: 0;
        }

        .aspect-vocalia-formatted p:first-child {
            margin-top: 0;
        }

        .aspect-vocalia-formatted p:last-child {
            margin-bottom: 0;
        }

        .aspect-vocalia-formatted > :first-child {
            margin-top: 0;
        }

        .aspect-vocalia-formatted > :last-child {
            margin-bottom: 0;
        }

        .aspect-vocalia-debug-status {
            display: grid;
            gap: 0.25em;
            padding: 0.5em;
            border: 1px solid var(--SmartThemeBorderColor);
            border-radius: 6px;
            opacity: 0.95;
        }

        .aspect-vocalia-debug-status code {
            white-space: normal;
            word-break: break-word;
        }
    `;

    document.head.appendChild(styleElement);
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
    const options = [
        [OVERLAY_STYLE_PLAIN, 'Plain text'],
        [OVERLAY_STYLE_ITALIC, 'CSS italic'],
        [OVERLAY_STYLE_ASTERISKS, 'SillyTavern asterisk styling'],
    ];

    return options.map(([value, label]) => {
        const selected = value === selectedStyle ? ' selected' : '';
        return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(label)}</option>`;
    }).join('');
}

function renderDiagnosticMemberRows() {
    const members = getGroupMembers();
    const triggered = getTriggeredThisTurnSet();

    if (!members.length) {
        return `
            <tr>
                <td colspan="3">
                    <em>No active group chat detected.</em>
                </td>
            </tr>`;
    }

    return members.map(member => {
        const status = getDiagnosticStatusForMember(member);
        const disabledText = member.disabled ? ' · disabled in group' : '';
        const allowanceText = triggered.has(member.avatar) ? 'spent' : 'available';

        return `
            <tr data-avatar="${escapeHtml(member.avatar)}">
                <td>
                    <div class="aspect-vocalia-member-name">${escapeHtml(member.name)}</div>
                    <div class="aspect-vocalia-member-avatar">${escapeHtml(member.avatar)}${escapeHtml(disabledText)}</div>
                </td>
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
                <div class="flex-container flexFlowColumn">
                    <label class="checkbox_label">
                        <input id="av_enabled" type="checkbox">
                        <span>Enable Extension</span>
                    </label>

                    <label class="checkbox_label">
                        <input id="av_auto_manual" type="checkbox">
                        <span>Change Group Reply Strategy to Manual Automatically</span>
                    </label>

                    <label class="checkbox_label">
                        <input id="av_restore_strategy" type="checkbox">
                        <span>Restore Original Group Reply Strategy Automatically</span>
                    </label>

                    <label class="checkbox_label">
                        <input id="av_use_slash" type="checkbox">
                        <span>Use silent /trigger first</span>
                    </label>

                    <label class="checkbox_label">
                        <input id="av_fallback_generate" type="checkbox">
                        <span>Fallback to internal force_chid generation if /trigger fails</span>
                    </label>

                    <hr>

                    <label for="av_arrival_mode">Apply first-assistant arriving= array</label>
                    <select id="av_arrival_mode" class="text_pole">
                        <option value="${ARRIVAL_APPLY_IMMEDIATE}">Immediately when the first assistant declares it</option>
                        <option value="${ARRIVAL_APPLY_DEFERRED}">After the current auto-reply chain ends</option>
                    </select>

                    <label class="checkbox_label">
                        <input id="av_first_name_match" type="checkbox">
                        <span>On First Message, Trigger Character by Name Match</span>
                    </label>

                    <label for="av_first_fallback">If No Character Match on First Message</label>
                    <select id="av_first_fallback" class="text_pole">
                        <option value="${FIRST_MESSAGE_FALLBACK_RANDOM_PRESENT}">Trigger a random eligible group member</option>
                        <option value="${FIRST_MESSAGE_FALLBACK_FIRST_PRESENT}">Trigger first eligible group member</option>
                        <option value="${FIRST_MESSAGE_FALLBACK_DO_NOTHING}">Do nothing</option>
                    </select>

                    <div class="flex-container alignItemsCenter">
                        <label for="av_max_triggers" class="flexGrow">Max Participants Per Turn</label>
                        <input id="av_max_triggers" class="text_pole widthUnset" type="number" min="1" max="10" step="1">
                    </div>

                    <div class="flex-container alignItemsCenter">
                        <label for="av_max_chain" class="flexGrow">Max Responses Per Turn</label>
                        <input id="av_max_chain" class="text_pole widthUnset" type="number" min="0" max="50" step="1">
                    </div>

                    <div class="flex-container alignItemsCenter">
                        <label for="av_trigger_delay" class="flexGrow">Delay Between Responses</label>
                        <input id="av_trigger_delay" class="text_pole widthUnset" type="number" min="0" max="10" step="0.05">
                    </div>

                    <hr>

                    <label class="checkbox_label">
                        <input id="av_render_overlay" type="checkbox">
                        <span>Display Raw Message as Refined Message</span>
                    </label>

                    <label class="checkbox_label">
                        <input id="av_hide_character_name" type="checkbox">
                        <span>Hide Character Name in Refined Message</span>
                    </label>

                    <label class="checkbox_label">
                        <input id="av_hide_thoughts" type="checkbox">
                        <span>Hide Thoughts in Refined Message</span>
                    </label>

                    <label class="checkbox_label">
                        <input id="av_quote_dialogue" type="checkbox">
                        <span>Wrap Dialogue in Quotes in Refined Message</span>
                    </label>

                    <label for="av_action_style">Style for Actions</label>
                    <select id="av_action_style" class="text_pole">
                        ${renderOverlayStyleOptions(getSettings().actionDisplayStyle)}
                    </select>

                    <label for="av_narration_style">Style for Narration</label>
                    <select id="av_narration_style" class="text_pole">
                        ${renderOverlayStyleOptions(getSettings().narrationDisplayStyle)}
                    </select>

                    <label for="av_thoughts_style">Style for Thoughts</label>
                    <select id="av_thoughts_style" class="text_pole">
                        ${renderOverlayStyleOptions(getSettings().thoughtsDisplayStyle)}
                    </select>

                    <hr>

                    <div class="flex-container alignItemsCenter">
                        <label for="av_prompt_depth" class="flexGrow">Protocol injection depth</label>
                        <input id="av_prompt_depth" class="text_pole widthUnset" type="number" min="0" max="100" step="1">
                    </div>

                    <label class="checkbox_label">
                        <input id="av_hide_debug_toasts" type="checkbox">
                        <span>Hide Debug Toasts</span>
                    </label>

                    <hr>

                    <b>Scene Diagnostics</b>

                    <div class="aspect-vocalia-array-list">
                        <div>Present: <code id="aspect_vocalia_array_present">none</code></div>
                        <div>Remote: <code id="aspect_vocalia_array_remote">none</code></div>
                        <div>Idle: <code id="aspect_vocalia_array_idle">none</code></div>
                        <div>Arriving: <code id="aspect_vocalia_array_arriving">none</code></div>
                        <div>Departing: <code id="aspect_vocalia_array_departing">none</code></div>
                        <div>Absent: <code id="aspect_vocalia_array_absent">none</code></div>
                        <div>Triggered this user turn: <code id="aspect_vocalia_array_triggered">none</code></div>
                    </div>

                    <table id="aspect_vocalia_member_state_table">
                        <thead>
                            <tr>
                                <th>Group member</th>
                                <th>Allowance</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody></tbody>
                    </table>

                    <hr>

                    <b>Debug Log</b>

                    <div class="aspect-vocalia-debug-status">
                        <div>Active: <code id="aspect_vocalia_debug_active">no</code></div>
                        <div>Entries: <code id="aspect_vocalia_debug_entries">0</code></div>
                        <div>Started: <code id="aspect_vocalia_debug_started">not started</code></div>
                        <div>Stopped: <code id="aspect_vocalia_debug_stopped">not stopped</code></div>
                    </div>

                    <div class="flex-container">
                        <input id="av_debug_start" class="menu_button" type="button" value="Start logging">
                        <input id="av_debug_stop" class="menu_button" type="button" value="Stop logging">
                        <input id="av_debug_copy" class="menu_button" type="button" value="Copy log">
                        <input id="av_debug_download" class="menu_button" type="button" value="Download log">
                        <input id="av_debug_clear" class="menu_button" type="button" value="Clear log">
                    </div>

                    <div class="flex-container">
                        <input id="av_sync_state" class="menu_button" type="button" value="Sync scene state from group">
                        <input id="av_render_now" class="menu_button" type="button" value="Apply render setting now">
                        <input id="av_dump_state" class="menu_button" type="button" value="Log state">
                    </div>

                    <small>
                        Present means physically in-scene. Remote means active phone/radio/video/text contact and eligible to respond. Absent means neither present nor remotely connected.
                    </small>
                </div>
            </div>
        </div>
    </div>`;

    const settingsPanel = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    settingsPanel.append(html);
    bindSettingsUi();
}

function formatDelaySeconds(milliseconds) {
    const seconds = Math.max(0, Number(milliseconds || 0) / 1000);
    return Number(seconds.toFixed(3)).toString();
}

function clampDelaySeconds(value) {
    return Math.min(10, Math.max(0, Number(value) || 0));
}

function loadSettingsUi() {
    const settings = getSettings();

    $('#av_enabled').prop('checked', !!settings.enabled);
    $('#av_auto_manual').prop('checked', !!settings.autoSetManual);
    $('#av_restore_strategy').prop('checked', !!settings.restoreOriginalStrategyOnDisable);
    $('#av_use_slash').prop('checked', !!settings.useSlashTrigger);
    $('#av_fallback_generate').prop('checked', !!settings.fallbackToInternalGenerate);

    $('#av_arrival_mode').val(settings.arrivalApplyMode);
    $('#av_first_name_match').prop('checked', !!settings.triggerNamedCharacterOnFirstUserMessage);
    $('#av_first_fallback').val(settings.firstMessageFallback);

    $('#av_max_triggers').val(String(settings.maxTriggersPerMessage));
    $('#av_max_chain').val(String(settings.maxChainReplies));
    $('#av_trigger_delay').val(formatDelaySeconds(settings.triggerDelayMs));

    $('#av_render_overlay').prop('checked', !!settings.renderOverlay);
    $('#av_hide_character_name').prop('checked', !!settings.hideCharacterNameInRefinedMessage);
    $('#av_hide_thoughts').prop('checked', !!settings.hideThoughtsInRefinedMessage);
    $('#av_quote_dialogue').prop('checked', !!settings.quoteDialogue);

    $('#av_action_style').val(settings.actionDisplayStyle);
    $('#av_narration_style').val(settings.narrationDisplayStyle);
    $('#av_thoughts_style').val(settings.thoughtsDisplayStyle);

    $('#av_prompt_depth').val(String(settings.promptDepth));
    $('#av_hide_debug_toasts').prop('checked', !!settings.hideDebugToasts);

    updateDiagnosticsPanel();
    updateDebugLogUi();
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
            const value = Math.min(max, Math.max(min, Number($(this).val()) || 0));
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
    bindCheckbox('#av_use_slash', 'useSlashTrigger');
    bindCheckbox('#av_fallback_generate', 'fallbackToInternalGenerate');

    bindSelect('#av_arrival_mode', 'arrivalApplyMode', async () => {
        if (getSettings().arrivalApplyMode === ARRIVAL_APPLY_IMMEDIATE) {
            applyPendingArrivals();
            await saveMetadata();
        }

        updateExtensionPrompt();
        updateDiagnosticsPanel();
    });

    bindCheckbox('#av_first_name_match', 'triggerNamedCharacterOnFirstUserMessage');
    bindSelect('#av_first_fallback', 'firstMessageFallback');

    bindNumber('#av_max_triggers', 'maxTriggersPerMessage', 1, 10);
    bindNumber('#av_max_chain', 'maxChainReplies', 0, 50);
    bindDelaySeconds('#av_trigger_delay');

    bindCheckbox('#av_render_overlay', 'renderOverlay', async () => {
        applyOverlaySettingToVisibleMessages();
    });

    bindCheckbox('#av_hide_character_name', 'hideCharacterNameInRefinedMessage', async () => renderAllVisibleOverlays());
    bindCheckbox('#av_hide_thoughts', 'hideThoughtsInRefinedMessage', async () => renderAllVisibleOverlays());
    bindCheckbox('#av_quote_dialogue', 'quoteDialogue', async () => renderAllVisibleOverlays());

    bindSelect('#av_action_style', 'actionDisplayStyle', async () => renderAllVisibleOverlays());
    bindSelect('#av_narration_style', 'narrationDisplayStyle', async () => renderAllVisibleOverlays());
    bindSelect('#av_thoughts_style', 'thoughtsDisplayStyle', async () => renderAllVisibleOverlays());

    bindNumber('#av_prompt_depth', 'promptDepth', 0, 100, async () => updateExtensionPrompt());
    bindCheckbox('#av_hide_debug_toasts', 'hideDebugToasts');

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

    loadSettingsUi();
}

// ============================================================================
// Section 16. Event Binding
// ============================================================================
// Purpose:
// - Register extension handlers with SillyTavern eventSource.
// - Observe chat DOM changes for overlay rendering.
// - Keep event binding separate from runtime enable/disable.
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
// Section 17. Runtime Lifecycle
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