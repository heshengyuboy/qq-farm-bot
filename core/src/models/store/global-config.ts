export {};
import type { AccountConfig, OfflineReminder, UIConfig, SystemConfig, Announcement, GlobalConfig } from '../../types/config';

const fs = require('node:fs');
const { readTextFile, writeJsonFileAtomic } = require('../../services/json-db');
const { DEFAULT_CLIENT_VERSION } = require('../../config/config');

const sharedState = require('./shared-state');

const {
    STORE_FILE,
    PUSHOO_CHANNELS,
    DEFAULT_OFFLINE_REMINDER,
    PREVIOUS_DEFAULT_CLIENT_VERSION,
    globalConfig,
    normalizeAccountConfig,
    cloneAccountConfig,
    DEFAULT_ACCOUNT_CONFIG,
} = sharedState;

function normalizeOfflineReminder(input: unknown): OfflineReminder {
    const src: Record<string, any> = (input && typeof input === 'object') ? input as Record<string, any> : {};
    let offlineDeleteSec = Number.parseInt(src.offlineDeleteSec, 10);
    if (!Number.isFinite(offlineDeleteSec) || offlineDeleteSec < 0) {
        offlineDeleteSec = DEFAULT_OFFLINE_REMINDER.offlineDeleteSec;
    }
    const rawChannel = (src.channel !== undefined && src.channel !== null)
        ? String(src.channel).trim().toLowerCase()
        : '';
    const endpoint = (src.endpoint !== undefined && src.endpoint !== null)
        ? String(src.endpoint).trim()
        : DEFAULT_OFFLINE_REMINDER.endpoint;
    const migratedChannel = rawChannel
        || (PUSHOO_CHANNELS.has(String(endpoint || '').trim().toLowerCase())
            ? String(endpoint || '').trim().toLowerCase()
            : DEFAULT_OFFLINE_REMINDER.channel);
    const channel = PUSHOO_CHANNELS.has(migratedChannel)
        ? migratedChannel
        : DEFAULT_OFFLINE_REMINDER.channel;
    const rawReloginUrlMode = (src.reloginUrlMode !== undefined && src.reloginUrlMode !== null)
        ? String(src.reloginUrlMode).trim().toLowerCase()
        : DEFAULT_OFFLINE_REMINDER.reloginUrlMode;
    const reloginUrlMode: OfflineReminder['reloginUrlMode'] = new Set(['none', 'qq_link', 'qr_link']).has(rawReloginUrlMode)
        ? rawReloginUrlMode as OfflineReminder['reloginUrlMode']
        : DEFAULT_OFFLINE_REMINDER.reloginUrlMode;
    const token = (src.token !== undefined && src.token !== null)
        ? String(src.token).trim()
        : DEFAULT_OFFLINE_REMINDER.token;
    const title = (src.title !== undefined && src.title !== null)
        ? String(src.title).trim()
        : DEFAULT_OFFLINE_REMINDER.title;
    const msg = (src.msg !== undefined && src.msg !== null)
        ? String(src.msg).trim()
        : DEFAULT_OFFLINE_REMINDER.msg;
    return {
        channel,
        reloginUrlMode,
        endpoint,
        token,
        title,
        msg,
        offlineDeleteSec,
    };
}

function sanitizeGlobalConfigBeforeSave(): void {
    sharedState.accountFallbackConfig = normalizeAccountConfig(globalConfig.defaultAccountConfig, DEFAULT_ACCOUNT_CONFIG);
    globalConfig.defaultAccountConfig = cloneAccountConfig(sharedState.accountFallbackConfig);

    const map = (globalConfig.accountConfigs && typeof globalConfig.accountConfigs === 'object')
        ? globalConfig.accountConfigs
        : {};
    const nextMap: Record<string, AccountConfig> = {};
    for (const [id, cfg] of Object.entries(map)) {
        const sid = String(id || '').trim();
        if (!sid) continue;
        nextMap[sid] = normalizeAccountConfig(cfg, DEFAULT_ACCOUNT_CONFIG);
    }
    globalConfig.accountConfigs = nextMap;

    const userReminders = (globalConfig.userOfflineReminders && typeof globalConfig.userOfflineReminders === 'object')
        ? globalConfig.userOfflineReminders
        : {};
    const nextReminders: Record<string, OfflineReminder> = {};
    for (const [username, cfg] of Object.entries(userReminders)) {
        const u = String(username || '').trim();
        if (!u) continue;
        nextReminders[u] = normalizeOfflineReminder(cfg);
    }
    globalConfig.userOfflineReminders = nextReminders;
}

function saveGlobalConfig(): void {
    const { ensureDataDir } = require('../../config/runtime-paths');
    ensureDataDir();
    try {
        const oldJson: string = readTextFile(STORE_FILE, '');

        sanitizeGlobalConfigBeforeSave();
        const newJson = JSON.stringify(globalConfig, null, 2);

        if (oldJson !== newJson) {
            console.warn('[系统] 正在保存配置到:', STORE_FILE);
            writeJsonFileAtomic(STORE_FILE, globalConfig);
        }
    } catch (e: any) {
        console.error('保存配置失败:', e.message);
    }
}

function getAdminPasswordHash(): string {
    return String(globalConfig.adminPasswordHash || '');
}

function setAdminPasswordHash(hash: unknown): string {
    globalConfig.adminPasswordHash = String(hash || '');
    saveGlobalConfig();
    return globalConfig.adminPasswordHash;
}

function getUI(): UIConfig {
    return { ...globalConfig.ui };
}

function setUITheme(theme: unknown): UIConfig {
    const t = String(theme || '').toLowerCase();
    const next: UIConfig['theme'] = (t === 'light') ? 'light' : 'dark';
    // Import here to avoid circular - use direct globalConfig mutation
    if (globalConfig.ui) {
        globalConfig.ui.theme = next;
    }
    saveGlobalConfig();
    return getUI();
}

function getOfflineReminder(username?: string): OfflineReminder {
    if (!username) {
        return normalizeOfflineReminder(globalConfig.offlineReminder);
    }
    const userCfg = globalConfig.userOfflineReminders && globalConfig.userOfflineReminders[username];
    if (userCfg) {
        return normalizeOfflineReminder(userCfg);
    }
    return normalizeOfflineReminder({});
}

function setOfflineReminder(cfg: Partial<OfflineReminder> | undefined, username?: string): OfflineReminder {
    if (!username) {
        const current = normalizeOfflineReminder(globalConfig.offlineReminder);
        globalConfig.offlineReminder = normalizeOfflineReminder({ ...current, ...(cfg || {}) });
        saveGlobalConfig();
        return getOfflineReminder();
    }
    if (!globalConfig.userOfflineReminders) {
        globalConfig.userOfflineReminders = {};
    }
    const current = normalizeOfflineReminder(globalConfig.userOfflineReminders[username] || {});
    globalConfig.userOfflineReminders[username] = normalizeOfflineReminder({ ...current, ...(cfg || {}) });
    saveGlobalConfig();
    return getOfflineReminder(username);
}

function deleteUserOfflineReminder(username: string): void {
    if (globalConfig.userOfflineReminders && globalConfig.userOfflineReminders[username]) {
        delete globalConfig.userOfflineReminders[username];
        saveGlobalConfig();
    }
}

function getAnnouncement(): Announcement {
    return {
        content: globalConfig.announcement?.content || '',
        showOnce: globalConfig.announcement?.showOnce ?? true,
        updatedAt: globalConfig.announcement?.updatedAt || 0,
    };
}

function setAnnouncement(content: unknown, showOnce: boolean = true): Announcement {
    globalConfig.announcement = {
        content: String(content || '').trim(),
        showOnce: !!showOnce,
        updatedAt: Date.now(),
    };
    saveGlobalConfig();
    return getAnnouncement();
}

function getAnnouncementReadRecord(username: string): number {
    if (!username) return 0;
    return globalConfig.announcementReadRecords?.[username] || 0;
}

function markAnnouncementRead(username: string): void {
    if (!username) return;
    if (!globalConfig.announcementReadRecords) {
        globalConfig.announcementReadRecords = {};
    }
    globalConfig.announcementReadRecords[username] = Date.now();
    saveGlobalConfig();
}

function shouldShowAnnouncement(username: string): boolean {
    const announcement = getAnnouncement();
    if (!announcement.content) return false;
    if (!username) return false;
    if (!announcement.showOnce) return true;
    const readAt = getAnnouncementReadRecord(username);
    return readAt < announcement.updatedAt;
}

function getSystemConfig(): SystemConfig | null {
    return globalConfig.systemConfig ? { ...globalConfig.systemConfig } : null;
}

function setSystemConfig(config: Partial<SystemConfig> | undefined): SystemConfig | null {
    if (!config || typeof config !== 'object') return null;
    const DEFAULT_DEVICE_INFO = {
        os: 'Windows',
        clientVersion: DEFAULT_CLIENT_VERSION,
        sysSoftware: 'Windows',
        network: 'wifi',
        memory: '16384',
        deviceId: 'DESKTOP-PC<WPC>',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13)',
    };
    const srcDevice = (config.deviceInfo && typeof config.deviceInfo === 'object') ? config.deviceInfo : {};
    const topVersion = String(config.clientVersion || '').trim();
    const deviceVersion = String((srcDevice as any).clientVersion || '').trim();
    const customDeviceVersion = deviceVersion && deviceVersion !== PREVIOUS_DEFAULT_CLIENT_VERSION ? deviceVersion : '';
    const customTopVersion = topVersion && topVersion !== PREVIOUS_DEFAULT_CLIENT_VERSION ? topVersion : '';
    const clientVersion = customDeviceVersion || customTopVersion || DEFAULT_DEVICE_INFO.clientVersion;
    const deviceInfo = {
        os: String((srcDevice as any).os || DEFAULT_DEVICE_INFO.os).trim(),
        clientVersion,
        sysSoftware: String((srcDevice as any).sysSoftware || DEFAULT_DEVICE_INFO.sysSoftware).trim(),
        network: String((srcDevice as any).network || DEFAULT_DEVICE_INFO.network).trim(),
        memory: String((srcDevice as any).memory || DEFAULT_DEVICE_INFO.memory).trim(),
        deviceId: String((srcDevice as any).deviceId || DEFAULT_DEVICE_INFO.deviceId).trim(),
        userAgent: String((srcDevice as any).userAgent || DEFAULT_DEVICE_INFO.userAgent).trim(),
    };
    globalConfig.systemConfig = {
        serverUrl: String(config.serverUrl || '').trim(),
        clientVersion: deviceInfo.clientVersion,
        platform: String(config.platform || 'qq').trim(),
        os: deviceInfo.os,
        deviceInfo,
        publicBaseUrl: String(config.publicBaseUrl || '').trim(),
    };
    saveGlobalConfig();
    return { ...globalConfig.systemConfig };
}

// Initialize on load
const { loadGlobalConfig } = sharedState;
loadGlobalConfig();
// Apply offlineReminder normalization after load
globalConfig.offlineReminder = normalizeOfflineReminder(globalConfig.offlineReminder);
for (const [username, cfg] of Object.entries(globalConfig.userOfflineReminders || {})) {
    globalConfig.userOfflineReminders[username] = normalizeOfflineReminder(cfg);
}
if (sharedState.systemConfigMigrated) {
    saveGlobalConfig();
    sharedState.systemConfigMigrated = false;
}

module.exports = {
    saveGlobalConfig,
    getAdminPasswordHash,
    setAdminPasswordHash,
    getUI,
    setUITheme,
    getOfflineReminder,
    setOfflineReminder,
    deleteUserOfflineReminder,
    getAnnouncement,
    setAnnouncement,
    getAnnouncementReadRecord,
    markAnnouncementRead,
    shouldShowAnnouncement,
    getSystemConfig,
    setSystemConfig,
};
