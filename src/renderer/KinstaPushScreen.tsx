import * as React from 'react';
import { useState, useEffect, useRef } from 'react';
import {
  FlyModal,
  PrimaryButton,
  TextButton,
  Checkbox,
  FlySelect,
  VirtualTable,
  IVirtualTableCellRendererDataArgs,
  ProgressBar,
  Spinner,
  Title,
  Close,
  ConnectPushIcon,
  FileAddedIcon,
  FileRightArrowIcon,
} from './localComponents';
import KinstaIcon from './KinstaIcon';
import {
  buildEnvInfo,
  envLabel as getEnvLabel,
  visibleDiffRows,
  summarizeSelection,
  buildPushFileSelection,
} from './pushHelpers';
import { STATUS, tint } from './colors';
import { Environment, EnvironmentInfo, SyncProgress } from './types';

const { ipcRenderer, shell } = window.require('electron');

const RSYNC_TROUBLESHOOTING_URL =
  'https://github.com/landerss0n/local-addon-kinsta#troubleshooting';

// Mirrors PushDiffRow in src/main/index.ts (+ renderer-side selection state)
interface DiffRow {
  path: string;
  op: 'add' | 'update' | 'delete';
  isDir: boolean;
  sizeBytes: number;
  localMtime?: number;
  selected: boolean;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  site: any;
  siteLink: {
    kinstaSiteId: string;
    kinstaSiteName: string;
    kinstaSiteSlug?: string;
  };
}

type SyncMode = 'newer' | 'all';

// Fullscreen sizing for the FlyModal (react-modal) — injected while mounted.
// <style> tags in JSX render as text inside Local, so we inject a real element.
const FULLSCREEN_CSS = `
/* Stretch FlyModal's themed content box to fill its (native) overlay.
   NOTE: className is APPENDED to FlyModal's own class — never pass
   overlayClassName, that would REPLACE their positioned backdrop. */
.KinstaPushModalContent {
  width: 100% !important;
  height: 100% !important;
  max-width: none !important;
  max-height: none !important;
  border-radius: 0 !important;
  padding: 0 !important;
  margin: 0 !important;
  text-align: left !important;
  display: flex;
  flex-direction: column;
}
/* FlyModal styles its direct child div with max-height:93vh + padding:60px
   (the ".FlyModal > div" rule) — undo that for the fullscreen layout */
.KinstaPushModalContent > div {
  flex: 1;
  min-height: 0;
  max-height: none !important;
  padding: 0 !important;
  overflow-y: hidden !important;
}
.KinstaPushCell {
  display: flex;
  align-items: center;
  padding: 0 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.KinstaPushRow {
  border-bottom: 1px solid rgba(127, 127, 127, 0.12);
}
`;

const formatMb = (bytes: number): string => {
  if (!bytes) return '0 mb';
  const mb = bytes / 1048576;
  return `${mb < 0.1 ? '<0.1' : mb.toFixed(1)} mb`;
};

const formatMtime = (ms?: number): string => {
  if (!ms) return '';
  const d = new Date(ms);
  return (
    d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  );
};

const KinstaPushScreen: React.FC<Props> = ({ isOpen, onClose, site, siteLink }) => {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [selectedEnvId, setSelectedEnvId] = useState<string>('');
  const [mode, setMode] = useState<SyncMode>('newer');
  const [includeDatabase, setIncludeDatabase] = useState(true);
  const [includeUploads, setIncludeUploads] = useState(false);
  const [kinstaBackup, setKinstaBackup] = useState(true);

  const [rows, setRows] = useState<DiffRow[]>([]);
  // starts true: a preview always runs on open, and the push button must stay
  // disabled until it lands — otherwise a quick click pushes an empty file
  // selection (selective path with files: [] silently skips all file changes)
  const [previewLoading, setPreviewLoading] = useState(true);
  const [degraded, setDegraded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [isPushing, setIsPushing] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [isComplete, setIsComplete] = useState(false);
  const [completionWarning, setCompletionWarning] = useState<string | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [brewCopied, setBrewCopied] = useState(false);

  const previewSeq = useRef(0);

  const copyBrewCommand = () => {
    navigator.clipboard.writeText('brew install rsync');
    setBrewCopied(true);
    setTimeout(() => setBrewCopied(false), 2000);
  };

  // FlyModal carries Local's theme (dark/light) — we inherit its
  // background/text. The file-list area gets the same subtle contrast
  // background first-party MagicSyncViewer_Content uses (#fafafa / #292a2a).
  const border = '1px solid rgba(127, 127, 127, 0.25)';
  const isDark =
    typeof document !== 'undefined' &&
    parseInt((getComputedStyle(document.body).backgroundColor.match(/\d+/) || ['255'])[0], 10) <
      128;
  const contentBg = isDark ? '#292a2a' : '#fafafa';

  // Inject the fullscreen/table CSS while the screen exists
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = FULLSCREEN_CSS;
    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  useEffect(() => {
    if (isOpen && siteLink) {
      setIsComplete(false);
      setError(null);
      setCompletionWarning(null);
      loadEnvironments();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load environments only when the screen opens / site link changes
  }, [isOpen, siteLink]);

  // Live progress (events carry siteId + mode so other sites/pulls are ignored)
  useEffect(() => {
    const handler = (_e: any, p: SyncProgress & { siteId?: string; mode?: string }) => {
      if (p.siteId !== site.id || p.mode !== 'push') return;
      if (p.stage === 'error' || p.stage === 'cancelled') return; // handled via invoke result
      setProgress(p);
      if (p.stage === 'done') {
        setIsComplete(true);
        setIsPushing(false);
      }
    };
    ipcRenderer.on('kinsta:syncProgress', handler);
    return () => {
      ipcRenderer.removeListener('kinsta:syncProgress', handler);
    };
  }, [site.id]);

  const loadEnvironments = async () => {
    const result = await ipcRenderer.invoke('kinsta:getEnvironments', siteLink.kinstaSiteId);
    if (result.success && result.environments.length > 0) {
      const envs = [...result.environments].sort(
        (a: Environment, b: Environment) => Number(b.is_premium) - Number(a.is_premium),
      );
      setEnvironments(envs);
      setSelectedEnvId(envs[0].id);
    } else if (!result.success) {
      setError(result.error || 'Could not load environments');
    }
  };

  const getEnvInfo = (envId: string): EnvironmentInfo | null =>
    buildEnvInfo(
      environments.find((e) => e.id === envId),
      siteLink,
    ) as EnvironmentInfo | null;

  // Re-run the dry-run preview whenever its inputs change (debounced)
  useEffect(() => {
    if (!isOpen || !selectedEnvId || isPushing || isComplete) return;
    const seq = ++previewSeq.current;
    setPreviewLoading(true);
    setError(null);
    const timer = setTimeout(async () => {
      const envInfo = getEnvInfo(selectedEnvId);
      if (!envInfo) {
        setPreviewLoading(false);
        return;
      }
      const result = await ipcRenderer.invoke('kinsta:pushPreview', site.id, site, envInfo, {
        mode,
        includeUploads,
      });
      if (seq !== previewSeq.current) return; // stale response — newer preview in flight
      setPreviewLoading(false);
      if (result.success) {
        setDegraded(!!result.degraded);
        const visible = visibleDiffRows<DiffRow>(result.rows || []);
        setRows(visible.map((r: DiffRow) => ({ ...r, selected: true })));
      } else {
        setError(result.error || 'Preview failed');
        setRows([]);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isPushing/isComplete are read-only guards and getEnvInfo is read inside the timeout — re-run only on the listed preview inputs
  }, [isOpen, selectedEnvId, mode, includeUploads, environments]);

  const selectedRows = rows.filter((r) => r.selected);
  const { addUpdateCount, deleteCount, totalBytes, allSelected, someSelected } =
    summarizeSelection(rows);

  const env = environments.find((e) => e.id === selectedEnvId);
  const isLive = !!env?.is_premium;
  const envLabel = getEnvLabel(env);

  const toggleAll = (checked: boolean) => {
    setRows((rs) => rs.map((r) => ({ ...r, selected: checked })));
  };
  const toggleRow = (rowPath: string, checked: boolean) => {
    setRows((rs) => rs.map((r) => (r.path === rowPath ? { ...r, selected: checked } : r)));
  };

  const handlePushClick = () => setShowConfirmModal(true);

  const executePush = async () => {
    setShowConfirmModal(false);
    const envInfo = getEnvInfo(selectedEnvId);
    if (!envInfo) {
      setError('Please select an environment');
      return;
    }

    setIsPushing(true);
    setError(null);
    setProgress({ stage: 'starting', progress: 0, message: 'Starting push...' });

    const result = await ipcRenderer.invoke('kinsta:push', site.id, site, envInfo, {
      includeDatabase,
      includeUploads,
      kinstaBackup,
      mode,
      // Full selection + "all modified" = plain rsync --delete fast path ({});
      // otherwise an explicit files/deletions list (selective, never blind-deletes)
      ...buildPushFileSelection(rows, mode),
    });

    if (result.success) {
      setCompletionWarning(result.warning || null);
      // Defensive: the 'done' progress event normally flips these; don't hang on
      // the spinner if it's ever dropped/reordered (idempotent with the event).
      setIsComplete(true);
      setIsPushing(false);
    } else {
      setError(result.cancelled ? null : result.error);
      setIsPushing(false);
      setIsCancelling(false);
      setProgress(null);
    }
  };

  const handleCancel = async () => {
    setIsCancelling(true);
    await ipcRenderer.invoke('kinsta:cancelSync', site.id);
  };

  const handleRequestClose = () => {
    if (isPushing) return; // no closing mid-push — cancel first
    onClose();
  };

  const cellRenderer = (args: IVirtualTableCellRendererDataArgs): React.ReactNode => {
    const { colKey, isHeader, rowData, extraData } = args;
    if (isHeader) {
      if (colKey === 'selected') {
        return (
          <Checkbox
            checked={extraData?.allSelected ? true : extraData?.someSelected ? 'mixed' : false}
            onChange={(checked: boolean) => toggleAll(checked)}
          />
        );
      }
      // Default header text — returning args.children renders the built-in cell
      return args.children;
    }
    const row = rowData as DiffRow;
    switch (colKey) {
      case 'selected':
        return (
          <Checkbox
            checked={row.selected}
            onChange={(checked: boolean) => toggleRow(row.path, checked)}
          />
        );
      case 'path':
        return (
          <span
            style={{ fontFamily: 'monospace', fontSize: '12px', opacity: row.selected ? 1 : 0.4 }}
          >
            {row.path}
            {row.isDir ? '/' : ''}
          </span>
        );
      case 'localMtime':
        return (
          <span style={{ opacity: row.selected ? 0.8 : 0.4 }}>
            {row.op === 'delete' ? '---' : formatMtime(row.localMtime)}
          </span>
        );
      case 'op':
        if (row.op === 'add') return <FileAddedIcon aria-hidden />;
        if (row.op === 'update') return <FileRightArrowIcon aria-hidden />;
        return <span style={{ color: STATUS.danger, fontWeight: 700 }}>✕</span>;
      case 'remote': {
        const color =
          row.op === 'add' ? STATUS.success : row.op === 'delete' ? STATUS.danger : undefined;
        const text =
          row.op === 'add'
            ? 'Will be added'
            : row.op === 'delete'
              ? 'Will be deleted'
              : 'Will be updated';
        return <span style={{ color, opacity: row.selected ? 1 : 0.4 }}>{text}</span>;
      }
    }
    return args.children;
  };

  const sectionTitle: React.CSSProperties = {
    fontSize: '15px',
    fontWeight: 600,
    textAlign: 'center',
    marginBottom: '14px',
  };

  if (!isOpen) return null;

  return (
    <FlyModal
      isOpen={isOpen}
      onRequestClose={handleRequestClose}
      contentLabel={`Push ${site.name || ''} to Kinsta`}
      shouldCloseOnOverlayClick={false}
      className="KinstaPushModalContent"
      hideCloseIcon /* we render the native Close inside the header instead */
    >
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* Header — centered title with the Close on the right (reference style) */}
        <header
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            height: '52px',
            padding: '0 60px',
            borderBottom: border,
            flexShrink: 0,
          }}
        >
          <ConnectPushIcon aria-hidden />
          <Title tag="h1" size="s" style={{ margin: 0 }}>
            Push {site.name || site.domain} to Kinsta
          </Title>
          <div
            style={{
              position: 'absolute',
              right: '16px',
              top: '50%',
              transform: 'translateY(-50%)',
            }}
          >
            <Close aria-label="Close Push Screen" position="static" onClick={handleRequestClose} />
          </div>
        </header>

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Left sidebar */}
          <div
            style={{
              width: '320px',
              flexShrink: 0,
              borderRight: border,
              padding: '40px 32px',
              display: 'flex',
              flexDirection: 'column',
              gap: '28px',
              overflowY: 'auto',
            }}
          >
            <div>
              <div style={sectionTitle}>Push site to</div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '12px',
                  padding: '14px 16px',
                  border: border,
                  borderRadius: '8px',
                }}
              >
                <KinstaIcon size={28} />
                <span
                  style={{
                    fontWeight: 600,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {siteLink.kinstaSiteName}
                </span>
              </div>
            </div>

            <div>
              <div style={sectionTitle}>Select environment</div>
              <FlySelect
                value={selectedEnvId}
                options={Object.fromEntries(
                  environments.map((e) => [
                    e.id,
                    e.is_premium ? 'Production' : `Staging (${e.display_name})`,
                  ]),
                )}
                onChange={(value: string) => setSelectedEnvId(value)}
                disabled={isPushing}
                style={{ width: '100%' }}
              />
            </div>

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
                width: 'fit-content',
                margin: '0 auto',
              }}
            >
              {/* local-components Checkbox passes the new boolean to onChange */}
              <Checkbox
                label="Include database"
                checked={includeDatabase}
                disabled={isPushing}
                onChange={(checked: boolean) => setIncludeDatabase(checked)}
              />
              <Checkbox
                label="Include uploads folder"
                checked={includeUploads}
                disabled={isPushing}
                onChange={(checked: boolean) => setIncludeUploads(checked)}
              />
              <Checkbox
                label="Create Kinsta backup first"
                checked={kinstaBackup}
                disabled={isPushing}
                onChange={(checked: boolean) => setKinstaBackup(checked)}
              />
            </div>

            <div style={{ textAlign: 'center', marginTop: 'auto' }}>
              {isLive && !isPushing && !isComplete && (
                <p style={{ fontSize: '12px', color: STATUS.danger, marginBottom: '10px' }}>
                  This will modify your production site.
                </p>
              )}
              <PrimaryButton
                onClick={handlePushClick}
                disabled={
                  isPushing ||
                  previewLoading ||
                  isComplete ||
                  (selectedRows.length === 0 && !includeDatabase)
                }
              >
                Push to Kinsta
              </PrimaryButton>
            </div>
          </div>

          {/* Right pane — mirrors first-party MagicSyncViewer_Content:
              height 100%, flex column, subtle contrast background */}
          <div
            style={{
              flex: '1 1 0',
              minWidth: 0,
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              backgroundColor: contentBg,
            }}
          >
            {isPushing || isComplete ? (
              /* Progress / completion view */
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '0 60px',
                  gap: '18px',
                }}
              >
                {isComplete ? (
                  <>
                    <div style={{ fontSize: '42px' }}>✓</div>
                    <Title size="m" style={{ margin: 0 }}>
                      Push complete!
                    </Title>
                    {completionWarning && (
                      <p
                        style={{
                          fontSize: '13px',
                          color: STATUS.warning,
                          textAlign: 'center',
                          maxWidth: '460px',
                        }}
                      >
                        {completionWarning}
                      </p>
                    )}
                    <PrimaryButton onClick={onClose}>Done</PrimaryButton>
                  </>
                ) : (
                  <>
                    <Spinner />
                    <div style={{ width: '100%', maxWidth: '420px' }}>
                      <ProgressBar progress={progress?.progress || 0} />
                    </div>
                    <p style={{ fontSize: '13px', opacity: 0.65, margin: 0 }}>
                      {progress?.message}
                    </p>
                    <TextButton onClick={handleCancel} disabled={isCancelling}>
                      {isCancelling ? 'Cancelling…' : 'Cancel'}
                    </TextButton>
                  </>
                )}
              </div>
            ) : (
              <>
                {/* Toolbar: mode select + counts */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px 20px',
                    borderBottom: border,
                    flexShrink: 0,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ fontWeight: 600, fontSize: '14px' }}>Push</span>
                    <FlySelect
                      value={mode}
                      options={{ newer: 'only newer files', all: 'all modified files' }}
                      onChange={(value: SyncMode) => setMode(value)}
                    />
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '14px',
                      fontSize: '13px',
                      opacity: 0.8,
                    }}
                  >
                    <span title="Files to sync">
                      ⟳ <strong>{addUpdateCount}</strong>
                    </span>
                    <span style={{ opacity: 0.3 }}>|</span>
                    <span
                      title="Files to delete"
                      style={{ color: deleteCount ? STATUS.danger : undefined }}
                    >
                      ✕ {deleteCount}
                    </span>
                    <span style={{ opacity: 0.3 }}>|</span>
                    <span>{formatMb(totalBytes)}</span>
                  </div>
                </div>

                {degraded && (
                  <div
                    style={{
                      padding: '10px 20px',
                      fontSize: '12px',
                      lineHeight: 1.5,
                      color: STATUS.warning,
                      backgroundColor: tint(STATUS.warning, 0.08),
                      borderBottom: border,
                      flexShrink: 0,
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>
                      Limited preview — file names only, no sizes or change type.
                    </div>
                    <div style={{ opacity: 0.85, marginTop: '2px' }}>
                      macOS ships openrsync, which doesn&apos;t support{' '}
                      <code>--itemize-changes</code>, so per-file sizes and change types can&apos;t
                      be detected. Installing GNU rsync enables the full diff.
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        marginTop: '6px',
                      }}
                    >
                      <code
                        style={{
                          backgroundColor: tint(STATUS.warning, 0.14),
                          padding: '2px 6px',
                          borderRadius: '3px',
                        }}
                      >
                        brew install rsync
                      </code>
                      <button
                        type="button"
                        onClick={copyBrewCommand}
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          margin: 0,
                          font: 'inherit',
                          lineHeight: 'inherit',
                          color: STATUS.warning,
                          textDecoration: 'underline',
                          cursor: 'pointer',
                        }}
                      >
                        {brewCopied ? 'Copied!' : 'Copy'}
                      </button>
                      <span style={{ opacity: 0.3 }}>|</span>
                      <a
                        href={RSYNC_TROUBLESHOOTING_URL}
                        onClick={(e) => {
                          e.preventDefault();
                          shell.openExternal(RSYNC_TROUBLESHOOTING_URL);
                        }}
                        style={{
                          color: STATUS.warning,
                          textDecoration: 'underline',
                          cursor: 'pointer',
                        }}
                      >
                        Troubleshooting
                      </a>
                    </div>
                  </div>
                )}

                {/* File diff table — direct child of the content column like
                    first-party (VirtualTable's own container is height:100%) */}
                {previewLoading ? (
                  <div
                    style={{
                      flex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '10px',
                      opacity: 0.65,
                    }}
                  >
                    <Spinner /> Comparing with Kinsta…
                  </div>
                ) : error ? (
                  <div
                    style={{
                      flex: 1,
                      padding: '24px',
                      color: STATUS.danger,
                      fontSize: '13px',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {error}
                  </div>
                ) : rows.length === 0 ? (
                  <div
                    style={{
                      flex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      opacity: 0.65,
                      fontSize: '14px',
                    }}
                  >
                    Everything is in sync — no file changes to push.
                  </div>
                ) : (
                  <VirtualTable
                    data={rows}
                    headers={[
                      { key: 'selected', value: '', flex: '0 0 44px' },
                      { key: 'path', value: 'Filename', flex: '1 1 auto' },
                      { key: 'localMtime', value: 'Local', flex: '0 0 160px' },
                      { key: 'op', value: '→', flex: '0 0 44px' },
                      { key: 'remote', value: `Kinsta (${envLabel})`, flex: '0 0 150px' },
                    ]}
                    rowKeyPropName="path"
                    cellClassName="KinstaPushCell"
                    rowClassName="KinstaPushRow"
                    cellRenderer={cellRenderer}
                    rowHeightSize="s"
                    rowHeaderHeightSize="m"
                    headersWeight={500}
                    headersCapitalize="none"
                    overscan={20}
                    striped
                    extraData={{ allSelected, someSelected }}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Confirmation modal (same pattern as the sync drawer) */}
      <FlyModal
        isOpen={showConfirmModal}
        onRequestClose={() => setShowConfirmModal(false)}
        contentLabel="Confirm Push"
      >
        <div style={{ padding: '30px', maxWidth: '420px', textAlign: 'center' }}>
          <Title size="l" style={{ marginBottom: '12px' }}>
            Push to {isLive ? 'Production' : 'Staging'}?
          </Title>
          <p style={{ color: '#888', fontSize: '14px', marginBottom: '10px', lineHeight: 1.5 }}>
            {addUpdateCount > 0 && <>{addUpdateCount} file(s) will be synced. </>}
            {deleteCount > 0 && (
              <strong style={{ color: STATUS.danger }}>
                {deleteCount} item(s) will be deleted on Kinsta — folders with their entire
                contents.{' '}
              </strong>
            )}
            {includeDatabase && (
              <>
                The {isLive ? 'production' : 'staging'} database will be replaced with your local
                database.{' '}
              </>
            )}
          </p>
          {isLive && (
            <p style={{ color: STATUS.danger, fontSize: '13px', marginBottom: '24px' }}>
              This will overwrite your production site. This action cannot be undone.
            </p>
          )}
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
            <TextButton onClick={() => setShowConfirmModal(false)}>Cancel</TextButton>
            <PrimaryButton
              onClick={executePush}
              style={
                isLive ? { backgroundColor: STATUS.danger, borderColor: STATUS.danger } : undefined
              }
            >
              Yes, Push to {isLive ? 'Production' : 'Staging'}
            </PrimaryButton>
          </div>
        </div>
      </FlyModal>
    </FlyModal>
  );
};

export default KinstaPushScreen;
