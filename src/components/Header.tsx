import React, { useState, useRef, useEffect } from "react";
import { 
  QrCode, 
  Settings, 
  FileSpreadsheet, 
  ChevronDown, 
  Check, 
  RotateCcw, 
  ShieldAlert,
  Cloud,
  HardDrive,
  RefreshCw
} from "lucide-react";

interface HeaderProps {
  darkMode: boolean;
  onToggleDarkMode: () => void;
  activeTab?: "dispatcher";
  onActiveTabChange?: (tab: "dispatcher") => void;
  onExportExcel?: () => void;
  onCleanDatabase?: () => void;
  onOpenBlocklist?: () => void;
  storageMode?: "cloud" | "offline";
  onToggleStorageMode?: () => void;
  isSyncing?: boolean;
  onSyncNow?: () => void;
  totalRecordsCount?: number;
  dispatchedCount?: number;
  vouchersCount?: number;
  onEmail?: () => void;
  onPrint?: () => void;
  onOutlook?: () => void;
}

function HeaderInner({
  darkMode,
  onToggleDarkMode,
  onExportExcel,
  onCleanDatabase,
  onOpenBlocklist,
  activeTab,
  onActiveTabChange,
  storageMode = "cloud",
  onToggleStorageMode,
  isSyncing = false,
  onSyncNow,
  totalRecordsCount = 0,
  dispatchedCount = 0,
  vouchersCount = 0,
}: HeaderProps) {
  const [showSettings, setShowSettings] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const isCloudMode = storageMode === "cloud";
  const recordsCount = totalRecordsCount;

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (settingsRef.current && !settingsRef.current.contains(event.target as Node)) {
        setShowSettings(false);
      }
    }
    if (showSettings) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showSettings]);

  return (
    <header className="park-header no-print">
      <div className="park-header-main">
        {/* Window control dots: Close, Minimize, Maximize */}
        <div className="window-control-dots" aria-hidden="true">
          <span className="window-dot dot-close" title="Close" />
          <span className="window-dot dot-minimize" title="Minimize" />
          <span className="window-dot dot-maximize" title="Maximize" />
        </div>

        {/* QR Code Icon */}
        <div className="park-qr-icon-wrapper" title="QR Code Permit Management">
          <QrCode className="w-7 h-7 text-[#5bdcff] dark:text-[#38bdf8]" />
        </div>

        {/* Main Title */}
        <h1 className="park-main-title">Patient &amp; Visitor Parking Voucher Generator</h1>
      </div>

      <div className="park-header-controls">
        {/* Export Excel button */}
        {onExportExcel && (
          <button
            type="button"
            className="park-header-btn park-export-btn"
            onClick={onExportExcel}
            title="Export database to Excel / CSV"
          >
            <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
            <span>Export</span>
          </button>
        )}

        {/* Settings Dropdown */}
        <div className="park-settings-wrap" ref={settingsRef}>
          <button
            type="button"
            className={`park-header-btn ${showSettings ? "active" : ""}`}
            onClick={() => setShowSettings((prev) => !prev)}
            title="Settings and views"
            aria-expanded={showSettings}
          >
            <Settings className="w-4 h-4" />
            <span>Settings</span>
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showSettings ? "rotate-180" : ""}`} />
          </button>

          {showSettings && (
            <div className="park-settings-menu">
              <div className="park-menu-section-label">Switch View</div>
              {onActiveTabChange && (
                <>
                  <button
                    type="button"
                    className={activeTab === "dispatcher" ? "selected" : ""}
                    onClick={() => {
                      onActiveTabChange("dispatcher");
                      setShowSettings(false);
                    }}
                  >
                    <span>Permit Dispatcher</span>
                    {activeTab === "dispatcher" && <Check className="w-3.5 h-3.5 text-[#5bdcff]" />}
                  </button>
                </>
              )}

              {(onExportExcel || onCleanDatabase || onOpenBlocklist) && (
                <>
                  <div className="park-menu-divider" />
                  <div className="park-menu-section-label">Data Actions</div>
                  {onExportExcel && (
                    <button
                      type="button"
                      onClick={() => {
                        onExportExcel();
                        setShowSettings(false);
                      }}
                    >
                      <span className="flex items-center">
                        <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400 mr-2 shrink-0" />
                        <span>Export to Spreadsheet</span>
                      </span>
                    </button>
                  )}
                  {onCleanDatabase && (
                    <button
                      type="button"
                      onClick={() => {
                        onCleanDatabase();
                        setShowSettings(false);
                      }}
                    >
                      <span className="flex items-center">
                        <RotateCcw className="w-3.5 h-3.5 text-blue-400 mr-2 shrink-0" />
                        <span>Clean Database</span>
                      </span>
                    </button>
                  )}
                  {onOpenBlocklist && (
                    <button
                      type="button"
                      onClick={() => {
                        onOpenBlocklist();
                        setShowSettings(false);
                      }}
                    >
                      <span className="flex items-center">
                        <ShieldAlert className="w-3.5 h-3.5 text-rose-400 mr-2 shrink-0" />
                        <span>Manage Blocklist</span>
                      </span>
                    </button>
                  )}
                </>
              )}

              {/* DATABASE & SYNC SETTINGS */}
              <div className="park-menu-divider" />
              <div className="park-menu-section-label">Database &amp; Sync Settings</div>
              <div className="park-admin-panel">
                {onToggleStorageMode && (
                  <div className="park-admin-panel-toggle">
                    <button
                      type="button"
                      onClick={() => {
                        if (!isCloudMode) onToggleStorageMode();
                      }}
                      className={`park-admin-toggle-btn ${isCloudMode ? "active-cloud" : ""}`}
                    >
                      <Cloud className="w-3.5 h-3.5 shrink-0" />
                      <span>Cloud Mode</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (isCloudMode) onToggleStorageMode();
                      }}
                      className={`park-admin-toggle-btn ${!isCloudMode ? "active-offline" : ""}`}
                    >
                      <HardDrive className="w-3.5 h-3.5 shrink-0" />
                      <span>Offline Mode</span>
                    </button>
                  </div>
                )}

                <div className="park-admin-stats-grid">
                  <div className="park-admin-stat-item">
                    <span className="park-admin-stat-label">Records</span>
                    <span className="park-admin-stat-val">{recordsCount}</span>
                  </div>
                  <div className="park-admin-stat-item">
                    <span className="park-admin-stat-label">Dispatched</span>
                    <span className="park-admin-stat-val">{dispatchedCount}</span>
                  </div>
                  <div className="park-admin-stat-item">
                    <span className="park-admin-stat-label">Vouchers</span>
                    <span className="park-admin-stat-val">{vouchersCount}</span>
                  </div>
                </div>

                {onSyncNow && (
                  <button
                    type="button"
                    onClick={onSyncNow}
                    disabled={isSyncing}
                    className="park-admin-sync-btn"
                    title="Synchronize database now"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${isSyncing ? "animate-spin" : ""}`} />
                    <span>{isSyncing ? "Syncing..." : "Sync Now"}</span>
                  </button>
                )}

                <div className="text-[10px] text-slate-500 dark:text-slate-400 text-center font-medium">
                  Auto-re-sync on reconnect active
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Dark Mode toggle */}
        <div className="park-dark-mode">
          <span>{darkMode ? "Dark Mode" : "Light Mode"}</span>
          <button 
            type="button" 
            className={`park-switch ${darkMode ? "is-on" : ""}`} 
            onClick={onToggleDarkMode} 
            aria-label={darkMode ? "Switch to light mode" : "Switch to dark mode"}
          >
            <span />
          </button>
        </div>
      </div>
    </header>
  );
}

export const Header = React.memo(HeaderInner);
Header.displayName = "Header";
