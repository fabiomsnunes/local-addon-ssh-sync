import * as React from 'react';
import { useState, useEffect } from 'react';
import {
  PrimaryButton,
  TextButton,
  Checkbox,
  RadioBlock,
  ProgressBar,
  Spinner,
  Title,
} from './localComponents';
import SyncIcon from './SyncIcon';
import { environmentTarget, remoteDomainOf } from './pushHelpers';
import { STATUS, tint } from './colors';
import { ServerEnvironment, SiteProfile, SyncProgress } from './types';

const { ipcRenderer } = window.require('electron');

interface Props {
  isOpen: boolean;
  onClose: () => void;
  site: any;
  profile: SiteProfile;
  initialEnvironmentId: string;
}

// Pull-only drawer. Push lives in the full-screen PushScreen (preview with
// per-file selection); this drawer owns the simpler "download from server" flow.
const PullDrawer: React.FC<Props> = ({ isOpen, onClose, site, profile, initialEnvironmentId }) => {
  const environments: ServerEnvironment[] = profile.environments;
  const [selectedEnvId, setSelectedEnvId] = useState<string>(initialEnvironmentId);
  const [includeDatabase, setIncludeDatabase] = useState(true);
  const [includeUploads, setIncludeUploads] = useState(false);
  const [makeSafe, setMakeSafe] = useState(true);
  const [safeCloneNote, setSafeCloneNote] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isComplete, setIsComplete] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setSelectedEnvId(initialEnvironmentId);
      loadLastSynced();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the drawer opens / the preselected environment changes
  }, [isOpen, initialEnvironmentId]);

  useEffect(() => {
    const progressHandler = (
      _event: any,
      progress: SyncProgress & { siteId?: string; mode?: string },
    ) => {
      // Events carry siteId + mode — ignore other sites' syncs and push events
      if (progress.siteId && progress.siteId !== site.id) return;
      if (progress.mode && progress.mode !== 'pull') return;
      if (progress.stage === 'error' || progress.stage === 'cancelled') return; // handled via invoke result
      setSyncProgress(progress);
      if (progress.stage === 'done') {
        setIsComplete(true);
        setIsSyncing(false);
      }
    };

    ipcRenderer.on('sshsync:syncProgress', progressHandler);
    return () => {
      ipcRenderer.removeListener('sshsync:syncProgress', progressHandler);
    };
  }, [site.id]);

  // The stored profile carries the lastPullAt timestamp
  const loadLastSynced = async () => {
    const stored: SiteProfile | null = await ipcRenderer.invoke('sshsync:getProfile', site.id);
    setLastSyncedAt(stored?.lastPullAt || null);
  };

  const handleCancel = async () => {
    setIsCancelling(true);
    await ipcRenderer.invoke('sshsync:cancelSync', site.id);
  };

  const executeSync = async () => {
    const env = environments.find((e) => e.id === selectedEnvId);
    if (!env) {
      setError('Please select an environment');
      return;
    }

    setIsSyncing(true);
    setError(null);
    setIsComplete(false);
    setSyncProgress({ stage: 'starting', progress: 0, message: 'Starting pull...' });

    setSafeCloneNote(null);
    const result = await ipcRenderer.invoke('sshsync:pull', site.id, site, env.id, {
      includeUploads,
      includeDatabase,
      makeSafe,
    });

    if (result.success) {
      setSafeCloneNote(result.note || null);
      loadLastSynced();
    } else {
      // Cancelled syncs return to the form without an error banner
      setError(result.cancelled ? null : result.error);
      setIsSyncing(false);
      setIsCancelling(false);
      setSyncProgress(null);
    }
  };

  const handleClose = () => {
    if (!isSyncing) {
      setError(null);
      setIsComplete(false);
      setIsCancelling(false);
      setSyncProgress(null);
      onClose();
    }
  };

  const selectedEnv = environments.find((e) => e.id === selectedEnvId);

  // Build radio options
  const envOptions: { [key: string]: any } = {};
  environments.forEach((env) => {
    envOptions[env.id] = {
      label: (
        <div style={{ textAlign: 'left' }}>
          <div style={{ fontWeight: 600 }}>
            {env.label}
            {env.isProduction && (
              <span style={{ marginLeft: '8px', fontSize: '11px', color: STATUS.danger }}>
                PRODUCTION
              </span>
            )}
          </div>
          <div style={{ fontSize: '12px', opacity: 0.7 }}>
            {remoteDomainOf(env.remoteUrl)} · {environmentTarget(env)}
          </div>
        </div>
      ),
    };
  });

  // Drawer overlay styles
  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    zIndex: 9998,
    opacity: isOpen ? 1 : 0,
    visibility: isOpen ? 'visible' : 'hidden',
    transition: 'opacity 0.3s ease, visibility 0.3s ease',
  };

  const drawerStyle: React.CSSProperties = {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    width: '480px',
    backgroundColor: '#292929',
    zIndex: 9999,
    transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
    transition: 'transform 0.3s ease',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '-4px 0 20px rgba(0, 0, 0, 0.3)',
  };

  const headerStyle: React.CSSProperties = {
    padding: '20px 24px',
    borderBottom: '1px solid #3e3e3e',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  };

  const contentStyle: React.CSSProperties = {
    flex: 1,
    padding: '24px',
    overflowY: 'auto',
  };

  const footerStyle: React.CSSProperties = {
    padding: '20px 24px',
    borderTop: '1px solid #3e3e3e',
  };

  return (
    <>
      {/* Drawer Overlay */}
      <div style={overlayStyle} onClick={handleClose} />

      {/* Drawer Panel */}
      <div style={drawerStyle}>
        {/* Header */}
        <div style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <SyncIcon size={28} />
            <div>
              <Title size="s" style={{ margin: 0 }}>
                Pull from server
              </Title>
              <span style={{ fontSize: '13px', opacity: 0.7 }}>{site.name || site.domain}</span>
            </div>
          </div>
          <button
            onClick={handleClose}
            disabled={isSyncing}
            style={{
              background: 'none',
              border: 'none',
              cursor: isSyncing ? 'not-allowed' : 'pointer',
              padding: '8px',
              opacity: isSyncing ? 0.5 : 1,
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#888"
              strokeWidth="2"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div style={contentStyle}>
          {!isSyncing && !isComplete && (
            <>
              {/* Environment Selection */}
              <div style={{ marginBottom: '24px' }}>
                <span
                  style={{
                    display: 'block',
                    marginBottom: '12px',
                    fontWeight: 600,
                    fontSize: '14px',
                  }}
                >
                  Select environment
                </span>

                {environments.length > 0 ? (
                  <RadioBlock
                    options={envOptions}
                    default={selectedEnvId}
                    onChange={(value: string) => setSelectedEnvId(value)}
                    direction="vert"
                  />
                ) : (
                  <div style={{ padding: '20px', textAlign: 'center' }}>
                    <Spinner />
                  </div>
                )}
              </div>

              {/* Options */}
              <div style={{ marginBottom: '24px' }}>
                <span
                  style={{
                    display: 'block',
                    marginBottom: '12px',
                    fontWeight: 600,
                    fontSize: '14px',
                  }}
                >
                  Options
                </span>
                <div
                  style={{
                    backgroundColor: '#1e1e1e',
                    borderRadius: '8px',
                    padding: '16px',
                  }}
                >
                  {/* local-components Checkbox calls onChange with the new
                      boolean, NOT a DOM event (unlike InputSearch) */}
                  <Checkbox
                    label="Include database"
                    checked={includeDatabase}
                    onChange={(checked: boolean) => setIncludeDatabase(checked)}
                  />
                  <div style={{ height: '12px' }} />
                  <Checkbox
                    label="Include uploads folder"
                    checked={includeUploads}
                    onChange={(checked: boolean) => setIncludeUploads(checked)}
                  />
                  <div style={{ height: '12px' }} />
                  <Checkbox
                    label="Make the local copy safe (recommended)"
                    checked={makeSafe}
                    onChange={(checked: boolean) => setMakeSafe(checked)}
                  />
                  <div style={{ fontSize: '12px', opacity: 0.6, margin: '6px 0 0 28px' }}>
                    Turns off backup, mail and remote-management plugins and blocks outgoing
                    requests and email, so this copy cannot reach the live site&apos;s services.
                  </div>
                </div>
              </div>

              {/* Info box */}
              <div
                style={{
                  backgroundColor: tint(STATUS.success, 0.1),
                  border: `1px solid ${tint(STATUS.success, 0.3)}`,
                  borderRadius: '8px',
                  padding: '16px',
                }}
              >
                <div style={{ display: 'flex', gap: '12px' }}>
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={STATUS.success}
                    strokeWidth="2"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4M12 8h.01" />
                  </svg>
                  <div style={{ fontSize: '13px', opacity: 0.9 }}>
                    Remote files will be downloaded from <strong>{selectedEnv?.label}</strong>.
                    {includeDatabase && ' Your local database will be replaced.'}
                  </div>
                </div>
              </div>

              {lastSyncedAt && (
                <div
                  style={{
                    marginTop: '12px',
                    fontSize: '12px',
                    opacity: 0.6,
                  }}
                >
                  Last pulled: {new Date(lastSyncedAt).toLocaleString()}
                </div>
              )}

              {error && (
                <div
                  style={{
                    marginTop: '16px',
                    padding: '12px 16px',
                    backgroundColor: tint(STATUS.danger, 0.1),
                    border: `1px solid ${tint(STATUS.danger, 0.3)}`,
                    borderRadius: '8px',
                    color: STATUS.danger,
                    fontSize: '13px',
                    whiteSpace: 'pre-wrap',
                    fontFamily: 'monospace',
                    maxHeight: '160px',
                    overflowY: 'auto',
                  }}
                >
                  {error}
                </div>
              )}
            </>
          )}

          {/* Syncing State */}
          {isSyncing && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                textAlign: 'center',
              }}
            >
              <div
                style={{
                  width: '80px',
                  height: '80px',
                  borderRadius: '50%',
                  backgroundColor: tint(STATUS.success, 0.15),
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: '24px',
                }}
              >
                <Spinner />
              </div>
              <Title size="m" style={{ marginBottom: '8px' }}>
                Pulling...
              </Title>
              <span style={{ opacity: 0.7, marginBottom: '24px', display: 'block' }}>
                {syncProgress?.message || 'Please wait...'}
              </span>
              <div style={{ width: '100%', maxWidth: '300px' }}>
                <ProgressBar progress={syncProgress?.progress || 0} />
              </div>
              <div style={{ marginTop: '24px' }}>
                <TextButton onClick={handleCancel} disabled={isCancelling}>
                  {isCancelling ? 'Cancelling...' : 'Cancel'}
                </TextButton>
              </div>
            </div>
          )}

          {/* Complete State */}
          {isComplete && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                textAlign: 'center',
              }}
            >
              <div
                style={{
                  width: '80px',
                  height: '80px',
                  borderRadius: '50%',
                  backgroundColor: tint(STATUS.success, 0.15),
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: '24px',
                }}
              >
                <svg
                  width="40"
                  height="40"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={STATUS.success}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <Title size="m" style={{ marginBottom: '8px', color: STATUS.success }}>
                Pull Complete!
              </Title>
              <span style={{ opacity: 0.7, marginBottom: '24px', display: 'block' }}>
                Your site has been synced successfully.
              </span>
              {safeCloneNote && (
                <span
                  style={{
                    opacity: 0.7,
                    fontSize: '12px',
                    marginBottom: '24px',
                    display: 'block',
                    maxWidth: '360px',
                  }}
                >
                  {safeCloneNote}
                </span>
              )}
              <TextButton onClick={handleClose}>Close</TextButton>
            </div>
          )}
        </div>

        {/* Footer */}
        {!isSyncing && !isComplete && (
          <div style={footerStyle}>
            <PrimaryButton
              onClick={executeSync}
              disabled={!selectedEnvId || environments.length === 0}
              style={{ width: '100%' }}
            >
              Pull from {selectedEnv?.label || 'server'}
            </PrimaryButton>
          </div>
        )}
      </div>
    </>
  );
};

export default PullDrawer;
