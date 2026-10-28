/*
 * Rent-Flow Google Drive backup helper.
 *
 * HTML setup:
 *   <script src="https://accounts.google.com/gsi/client" async defer></script>
 *   <script src="google-drive-sync.js" defer></script>
 *   <button type="button" onclick="uploadToGoogleDrive()">🌸 一键同步到 Google 网盘（防手机丢失）</button>
 *   <button type="button" onclick="loadFromGoogleDrive()">🔄 从网盘恢复历史数据</button>
 *   <p id="driveSyncStatus" role="status" aria-live="polite"></p>
 *
 * Replace YOUR_CLIENT_ID with the OAuth 2.0 Web client ID.
 * Required OAuth scope: https://www.googleapis.com/auth/drive.file
 */
(() => {
    'use strict';

    const GOOGLE_CLIENT_ID = '51963447636-omne8ibrk4ff6ij11ojcbmusin3sngtp.apps.googleusercontent.com';
    const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
    const BACKUP_FILENAME = 'Rent-Flow-Backup.json';
    const BACKUP_MIME_TYPE = 'application/json';
    const DRIVE_API = 'https://www.googleapis.com/drive/v3';
    const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

    let tokenClient = null;
    let accessToken = null;
    let tokenExpiresAt = 0;
    let pendingTokenRequest = null;

    function setStatus(message, isError = false) {
        const status = document.getElementById('driveSyncStatus');
        if (!status) return;
        status.textContent = message;
        status.style.color = isError ? '#b03a2e' : '#117864';
    }

    function initGoogleDriveAuth() {
        if (tokenClient) return tokenClient;
        if (!window.google?.accounts?.oauth2) {
            throw new Error('Google 登录组件还没加载完成，请稍后重试。');
        }
        if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID === 'YOUR_CLIENT_ID') {
            throw new Error('请先在 google-drive-sync.js 中填写 Google OAuth Client ID。');
        }

        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: GOOGLE_CLIENT_ID,
            scope: DRIVE_SCOPE,
            callback: (response) => {
                if (!pendingTokenRequest) return;
                if (response?.error || !response?.access_token) {
                    pendingTokenRequest.reject(new Error(
                        response?.error_description || response?.error || '没有取得 Google 授权，请重试。'
                    ));
                    pendingTokenRequest = null;
                    return;
                }
                accessToken = response.access_token;
                tokenExpiresAt = Date.now() + (Number(response.expires_in || 3600) - 30) * 1000;
                pendingTokenRequest.resolve(accessToken);
                pendingTokenRequest = null;
            },
            error_callback: (error) => {
                console.error('Google 授权窗口错误：', error);
                if (pendingTokenRequest) {
                    pendingTokenRequest.reject(new Error(error?.message || 'Google 授权窗口无法打开。'));
                    pendingTokenRequest = null;
                }
            }
        });
        return tokenClient;
    }

    function requestDriveAccess() {
        return new Promise((resolve, reject) => {
            let client;
            try {
                client = initGoogleDriveAuth();
            } catch (error) {
                reject(error);
                return;
            }

            pendingTokenRequest = { resolve, reject };

            // GIS token 会过期，且只保存在内存中；每次用户主动同步时重新请求。
            client.requestAccessToken({ prompt: '' });
        });
    }

    async function getDriveToken() {
        if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
        return requestDriveAccess();
    }

    async function driveRequest(url, options = {}) {
        const token = await getDriveToken();
        const response = await fetch(url, {
            ...options,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(options.headers || {})
            }
        });

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            let message = `Google Drive 请求失败（${response.status}）。`;
            if (response.status === 401) {
                accessToken = null;
                tokenExpiresAt = 0;
                message = 'Google 授权已过期，请再点一次同步或恢复。';
            } else if (response.status === 403) {
                message = 'Google 账号没有文件访问权限。请检查 Drive API、授权范围和 OAuth 设置。';
            }
            throw new Error(detail ? `${message}\n${detail}` : message);
        }
        if (response.status === 204) return null;
        return response.json();
    }

    function collectLocalStorage() {
        const entries = [];
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (key !== null) entries.push([key, localStorage.getItem(key)]);
        }
        return {
            format: 'rent-flow-localstorage-backup',
            version: 1,
            savedAt: new Date().toISOString(),
            origin: location.origin,
            entries
        };
    }

    async function findBackupFile() {
        // drive.file 只能列出此应用创建或用户明确交给此应用的文件。
        // 不会扫描用户 Drive 中所有同名文件。
        const query = `name = '${BACKUP_FILENAME}' and trashed = false`;
        const params = new URLSearchParams({
            q: query,
            spaces: 'drive',
            pageSize: '100',
            orderBy: 'modifiedTime desc',
            fields: 'files(id,name,mimeType,modifiedTime,size)'
        });
        const result = await driveRequest(`${DRIVE_API}/files?${params}`);
        const files = result.files || [];
        if (files.length > 1) {
            console.warn(`Drive 中找到 ${files.length} 个同名备份，将更新最近修改的一个。`);
        }
        return files[0] || null;
    }

    async function uploadBackupFile(payload) {
        const existing = await findBackupFile();
        const metadata = {
            name: BACKUP_FILENAME,
            mimeType: BACKUP_MIME_TYPE
        };
        const fileBody = new Blob([JSON.stringify(payload)], { type: BACKUP_MIME_TYPE });
        const url = existing
            ? `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(existing.id)}?uploadType=resumable&fields=id,name,modifiedTime`
            : `${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=id,name,modifiedTime`;
        const token = await getDriveToken();
        const startResponse = await fetch(url, {
            method: existing ? 'PATCH' : 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json; charset=UTF-8',
                'X-Upload-Content-Type': BACKUP_MIME_TYPE,
                'X-Upload-Content-Length': String(fileBody.size)
            },
            body: JSON.stringify(metadata)
        });
        if (!startResponse.ok) {
            const detail = await startResponse.text().catch(() => '');
            throw new Error(`无法开始上传备份（${startResponse.status}）。${detail}`);
        }
        const uploadUrl = startResponse.headers.get('Location');
        if (!uploadUrl) throw new Error('Google Drive 没有返回上传地址，请重试。');

        const uploadResponse = await fetch(uploadUrl, {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': BACKUP_MIME_TYPE
            },
            body: fileBody
        });
        if (!uploadResponse.ok) {
            const detail = await uploadResponse.text().catch(() => '');
            throw new Error(`备份上传失败（${uploadResponse.status}）。${detail}`);
        }
        return uploadResponse.json();
    }

    async function uploadToGoogleDrive() {
        setStatus('正在连接 Google Drive…');
        try {
            await getDriveToken();
            const payload = collectLocalStorage();
            const result = await uploadBackupFile(payload);
            setStatus(`备份完成：${result.name}（${new Date(result.modifiedTime).toLocaleString()}）`);
            alert('已将当前浏览器中的全部本地数据备份到 Google Drive。');
        } catch (error) {
            console.error(error);
            setStatus(error.message || '备份失败，请检查网络和 Google 设置。', true);
            alert(error.message || '备份失败，请检查网络和 Google 设置。');
        }
    }

    async function loadFromGoogleDrive() {
        setStatus('正在查找 Google Drive 备份…');
        try {
            await getDriveToken();
            const file = await findBackupFile();
            if (!file) {
                throw new Error(`没有找到 ${BACKUP_FILENAME}。请先在原设备点“一键同步到 Google 网盘”。`);
            }
            if (!confirm('恢复会替换此浏览器里的全部网站数据。建议先在此设备导出一份备份。确定继续吗？')) {
                setStatus('已取消恢复。');
                return;
            }

            const payload = await driveRequest(`${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`);
            if (payload?.format !== 'rent-flow-localstorage-backup' || !Array.isArray(payload.entries)) {
                throw new Error('备份文件格式不正确，未更改当前数据。');
            }

            const validEntries = payload.entries.every(entry =>
                Array.isArray(entry) && entry.length === 2 &&
                typeof entry[0] === 'string' &&
                (typeof entry[1] === 'string' || entry[1] === null)
            );
            if (!validEntries) throw new Error('备份内容不完整或格式有误，未更改当前数据。');

            // 先留一份内存回滚副本；写入任何项目失败时恢复原有数据。
            const previousEntries = [];
            for (let index = 0; index < localStorage.length; index += 1) {
                const key = localStorage.key(index);
                if (key !== null) previousEntries.push([key, localStorage.getItem(key)]);
            }

            try {
                localStorage.clear();
                for (const [key, value] of payload.entries) {
                    if (value !== null) localStorage.setItem(key, value);
                }
            } catch (writeError) {
                localStorage.clear();
                for (const [key, value] of previousEntries) {
                    if (value !== null) localStorage.setItem(key, value);
                }
                throw new Error(`写入本地失败，原数据已恢复。${writeError.message}`);
            }

            setStatus(`恢复完成：${file.name}（备份时间：${payload.savedAt || '未知'}）`);
            alert('数据已恢复，网页即将重新载入。');
            location.reload();
        } catch (error) {
            console.error(error);
            setStatus(error.message || '恢复失败，请检查网络和 Google 设置。', true);
            alert(error.message || '恢复失败，请检查网络和 Google 设置。');
        }
    }

    window.uploadToGoogleDrive = uploadToGoogleDrive;
    window.loadFromGoogleDrive = loadFromGoogleDrive;
    window.initGoogleDriveAuth = initGoogleDriveAuth;
})();
