import React, { useState, useRef, useEffect, forwardRef, useImperativeHandle } from "react";
import { 
  CsvPermitRecord, 
  ParsedVoucherData, 
  parsePermitExcel, 
  parsePermitCsv, 
  parseVoucherFile, 
  parsePastedText, 
  parseDateToISO, 
  addDays,
  getTodayISO,
  generateNextFormId,
  sortRecordsByFormIdDesc,
  exportToExcel,
  formatPhoneNumber,
  cleanVoucherCodeValue,
  formatFormId,
  getRecordSubmittedDateISO
} from "../utils/csvParser";
import { safeLocalStorage } from "../utils/safeLocalStorage";
import { isSupabaseConfigured } from "../lib/supabase";
import { useLoading } from "../contexts/LoadingContext";
import { validateVoucherCSV, type VoucherValidationError } from "../utils/voucherValidation";
import { VoucherImportBlockedModal } from "./VoucherImportBlockedModal";

// Helper to format string to Title Case (capitalize each word)
function toTitleCase(str: string): string {
  if (!str || str === "-") return str;
  return str
    .toLowerCase()
    .replace(/(?:^|\s|-)\S/g, (char) => char.toUpperCase());
}

const HOSPITAL_SITES = [
  "Whipps Cross Hospital",
  "Newham Hospital"
];

import { INITIAL_DEMO_CSV } from "../data/defaultCsv";
import { 
  Database, 
  Upload, 
  Check, 
  AlertCircle,
  Trash2,
  RotateCcw,
  Ticket,
  ChevronDown,
  ChevronUp,
  Search,
  Plus,
  Download,
  Table,
  X,
  RefreshCw,
  Clock,
  Calendar
} from "lucide-react";

interface CsvDatabasePanelProps {
  database: CsvPermitRecord[];
  totalRecordsCount?: number;
  onDatabaseChange: (records: CsvPermitRecord[]) => void;
  vouchersDatabase: ParsedVoucherData[];
  onVouchersDatabaseChange: (vouchers: ParsedVoucherData[]) => void;
  onSelectRecord?: (record: CsvPermitRecord) => void;
  onRefreshDatabase?: () => void;
  dispatchedKeys?: string[];
  dispatchDates?: {[key: string]: string};
  searchQuery?: string;
  onSearchQueryChange?: (query: string) => void;
  showTable?: boolean;
  onShowTableChange?: (show: boolean) => void;
  dateRangeFilter?: '7days' | '30days' | 'all';
  onDateRangeFilterChange?: (filter: '7days' | '30days' | 'all') => void;
  isLoadingHistory?: boolean;
  processingDate?: string;
  onProcessingDateChange?: (dateISO: string) => void;
  customVouchersMap?: Record<string, string>;
}

export interface CsvDatabasePanelHandle {
  browseConcessions: () => void;
  browseVouchers: () => void;
}

export const CsvDatabasePanel = React.memo(forwardRef<CsvDatabasePanelHandle, CsvDatabasePanelProps>(function CsvDatabasePanel({ 
  database, 
  totalRecordsCount,
  onDatabaseChange, 
  vouchersDatabase, 
  onVouchersDatabaseChange, 
  onSelectRecord,
  onRefreshDatabase,
  dispatchedKeys = [],
  dispatchDates = {},
  searchQuery: searchQueryProp,
  onSearchQueryChange,
  showTable: propShowTable,
  onShowTableChange,
  dateRangeFilter = '7days',
  onDateRangeFilterChange,
  isLoadingHistory = false,
  processingDate,
  onProcessingDateChange,
  customVouchersMap
}: CsvDatabasePanelProps, ref: React.Ref<CsvDatabasePanelHandle>) {
  const [concessionsInputMode, setConcessionsInputMode] = useState<"file" | "paste">("file");
  const [pastedConcessions, setPastedConcessions] = useState("");
  const [internalShowTable, setInternalShowTable] = useState(false);
  const showTable = propShowTable !== undefined ? propShowTable : internalShowTable;
  const setShowTable = (val: boolean) => {
    setInternalShowTable(val);
    if (onShowTableChange) onShowTableChange(val);
  };
  const [showNewEntryModal, setShowNewEntryModal] = useState(false);
  
  // New Entry Form State
  const [newFormHospital, setNewFormHospital] = useState("Whipps Cross Hospital");
  const [newFormWard, setNewFormWard] = useState("");
  const [newFormDateReq, setNewFormDateReq] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [newFormDateExp, setNewFormDateExp] = useState("");
  const [newFormVrm, setNewFormVrm] = useState("");
  const [newFormDriverName, setNewFormDriverName] = useState("");
  const [newFormPhone, setNewFormPhone] = useState("");
  const [newFormEmail, setNewFormEmail] = useState("");
  const [newFormVoucherCode, setNewFormVoucherCode] = useState("-");
  const [newFormStartTime, setNewFormStartTime] = useState("");

  const [dragActive, setDragActive] = useState(false);
  const [vouchersDragActive, setVouchersDragActive] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [voucherValidationErrors, setVoucherValidationErrors] = useState<VoucherValidationError[] | null>(null);
  const [blockedFileName, setBlockedFileName] = useState<string>("");

  // Auto-dismiss feedback status message after 4.5 seconds
  useEffect(() => {
    if (!feedbackMsg) return;
    const timer = setTimeout(() => {
      setFeedbackMsg(null);
    }, 4500);
    return () => clearTimeout(timer);
  }, [feedbackMsg]);
  
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(() => {
    const cachedName = safeLocalStorage.getItem("concessions_uploaded_file_name");
    if (cachedName) return cachedName;
    return null;
  });

  const [uploadedVouchersFileName, setUploadedVouchersFileName] = useState<string | null>(() => {
    const cachedName = safeLocalStorage.getItem("concessions_uploaded_vouchers_file_name");
    if (cachedName && !cachedName.includes("Codes")) return cachedName;
    return null;
  });

  const { showLoading, hideLoading, updateProgress } = useLoading();

  const [localSearchQuery, setLocalSearchQuery] = useState("");
  const isControlledSearch = searchQueryProp !== undefined;
  const searchQuery = isControlledSearch ? searchQueryProp : localSearchQuery;
  const setSearchQuery = (val: string) => {
    if (onSearchQueryChange) {
      onSearchQueryChange(val);
    } else {
      setLocalSearchQuery(val);
    }
  };

  const [showDropdown, setShowDropdown] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const vouchersFileInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    browseConcessions: () => fileInputRef.current?.click(),
    browseVouchers: () => vouchersFileInputRef.current?.click(),
  }), []);

  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(searchQuery);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 150);
    return () => clearTimeout(handler);
  }, [searchQuery]);

  const sortedDatabase = React.useMemo(() => {
    return sortRecordsByFormIdDesc(database);
  }, [database]);

  // Close search dropdown on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  // Synchronize display status when database prop changes
  useEffect(() => {
    const cachedName = safeLocalStorage.getItem("concessions_uploaded_file_name");
    if (cachedName) {
      setUploadedFileName(cachedName);
    } else if (database.length === 0) {
      setUploadedFileName(null);
    } else {
      setUploadedFileName(`_Visitor _ Patient Parking Concessions Request Form(1-${database.length}).xlsx`);
    }
  }, [database]);

  // Synchronize vouchers display status when vouchersDatabase prop changes
  useEffect(() => {
    const cachedName = safeLocalStorage.getItem("concessions_uploaded_vouchers_file_name");
    if (cachedName && !cachedName.includes("Codes")) {
      setUploadedVouchersFileName(cachedName);
    } else if (vouchersDatabase.length === 0) {
      setUploadedVouchersFileName(null);
    } else {
      setUploadedVouchersFileName(cachedName || null);
    }
  }, [vouchersDatabase]);

  // Parse uploaded concessions file
  const handleFile = (file: File) => {
    const fileName = file.name.toLowerCase();
    if (!fileName.endsWith(".xlsx") && !fileName.endsWith(".xls")) {
      setFeedbackMsg({
        type: "error",
        text: "Invalid file type. Please upload a valid Concessions Excel file (.xlsx or .xls)."
      });
      return;
    }

    showLoading("Uploading spreadsheet...", 15);
    const reader = new FileReader();

    reader.onprogress = (event) => {
      if (event.lengthComputable) {
        const progress = Math.min(85, Math.round((event.loaded / event.total) * 70) + 15);
        updateProgress(progress);
      }
    };

    reader.onload = (event) => {
      try {
        updateProgress(90);
        const arrayBuffer = event.target?.result as ArrayBuffer;
        const records = parsePermitExcel(arrayBuffer);
        
        if (records.length === 0) {
          hideLoading();
          setFeedbackMsg({
            type: "error",
            text: "No valid permit records found. Please ensure headers match like VRM, Driver, Hospital, Ward."
          });
          return;
        }

        const sorted = sortRecordsByFormIdDesc(records);
        onDatabaseChange(sorted);
        setUploadedFileName(file.name);
        safeLocalStorage.setItem("concessions_uploaded_file_name", file.name);
        updateProgress(100);
        setTimeout(hideLoading, 350);
        setFeedbackMsg({
          type: "success",
          text: `Processed ${sorted.length} records. Database appended/updated successfully!`
        });
      } catch (e: any) {
        hideLoading();
        setFeedbackMsg({
          type: "error",
          text: `Concessions failed: ${e.message || "Unknown error"}`
        });
      }
    };

    reader.onerror = () => {
      hideLoading();
      setFeedbackMsg({
        type: "error",
        text: "Failed to read file."
      });
    };

    reader.readAsArrayBuffer(file);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  // Parse uploaded vouchers file
  const handleVouchersFile = (file: File) => {
    const fileName = file.name.toLowerCase();
    if (!fileName.endsWith(".csv")) {
      setFeedbackMsg({
        type: "error",
        text: "Invalid file type. Please upload a valid Voucher Codes CSV file (.csv)."
      });
      return;
    }

    showLoading("Uploading voucher codes...", 15);
    const reader = new FileReader();

    reader.onprogress = (event) => {
      if (event.lengthComputable) {
        const progress = Math.min(85, Math.round((event.loaded / event.total) * 70) + 15);
        updateProgress(progress);
      }
    };

    reader.onload = (event) => {
      try {
        updateProgress(85);
        const arrayBuffer = event.target?.result as ArrayBuffer;

        // Pre-import validation check for uploaded Voucher CSV files
        const validation = validateVoucherCSV(arrayBuffer, file.name);
        if (!validation.isValid) {
          hideLoading();
          setVoucherValidationErrors(validation.errors);
          setBlockedFileName(file.name);
          setFeedbackMsg({
            type: "error",
            text: `⚠️ Import Blocked: Found invalid voucher date ranges in ${validation.errors.length} row${validation.errors.length === 1 ? '' : 's'}!`
          });
          if (vouchersFileInputRef.current) {
            vouchersFileInputRef.current.value = "";
          }
          return;
        }

        updateProgress(95);
        const vouchers = validation.vouchers;
        
        if (vouchers.length === 0) {
          hideLoading();
          setFeedbackMsg({
            type: "error",
            text: "No valid voucher codes found. Ensure the file contains voucher codes under a 'Voucher' column or is a single-column list."
          });
          return;
        }

        onVouchersDatabaseChange(vouchers);
        setUploadedVouchersFileName(file.name);
        safeLocalStorage.setItem("concessions_uploaded_vouchers_file_name", file.name);
        updateProgress(100);
        setTimeout(hideLoading, 350);
        setFeedbackMsg({
          type: "success",
          text: `Processed ${vouchers.length} voucher codes. Database appended/updated successfully!`
        });
      } catch (e: any) {
        hideLoading();
        setFeedbackMsg({
          type: "error",
          text: `Vouchers failed: ${e.message || "Unknown error"}`
        });
      }
    };

    reader.onerror = () => {
      hideLoading();
      setFeedbackMsg({
        type: "error",
        text: "Failed to read vouchers file."
      });
    };

    reader.readAsArrayBuffer(file);
  };

  const handleVouchersFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleVouchersFile(file);
  };

  const handleVouchersDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setVouchersDragActive(true);
    } else if (e.type === "dragleave") {
      setVouchersDragActive(false);
    }
  };

  const handleVouchersDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setVouchersDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleVouchersFile(file);
  };

  // Handle New Entry creation
  const handleCreateNewEntry = (e: React.FormEvent) => {
    e.preventDefault();
    const nextFormId = generateNextFormId(database);
    
    let formattedDateReq = newFormDateReq;
    if (formattedDateReq && formattedDateReq.includes("-")) {
      const parts = formattedDateReq.split("-");
      if (parts.length === 3) {
        formattedDateReq = `${parts[2]}/${parts[1]}/${parts[0]}`;
      }
    }

    let formattedDateExp = newFormDateExp;
    if (formattedDateExp && formattedDateExp.includes("-")) {
      const parts = formattedDateExp.split("-");
      if (parts.length === 3) {
        formattedDateExp = `${parts[2]}/${parts[1]}/${parts[0]}`;
      }
    } else if (!formattedDateExp && newFormDateReq) {
      const dateIso = parseDateToISO(newFormDateReq) || newFormDateReq;
      const expIso = addDays(dateIso, 6);
      const parts = expIso.split("-");
      if (parts.length === 3) {
        formattedDateExp = `${parts[2]}/${parts[1]}/${parts[0]}`;
      }
    }

    const newRecord: CsvPermitRecord = {
      id: nextFormId,
      formId: nextFormId,
      hospital: newFormHospital || "Whipps Cross Hospital",
      ward: newFormWard || "Administration",
      dateRequired: formattedDateReq || "01/01/2026",
      dateExpiry: formattedDateExp || "07/01/2026",
      vrm: newFormVrm ? newFormVrm.toUpperCase().replace(/\s+/g, "") : "PENDING",
      driverName: newFormDriverName ? toTitleCase(newFormDriverName) : "New Driver",
      phone: newFormPhone ? formatPhoneNumber(newFormPhone) : "",
      email: newFormEmail ? newFormEmail.toLowerCase().trim() : "",
      voucherCode: newFormVoucherCode && newFormVoucherCode.trim() !== "" ? newFormVoucherCode.trim() : "-",
      startTime: newFormStartTime || new Date().toLocaleString("en-GB"),
      createdAt: new Date().toISOString()
    };

    const updated = sortRecordsByFormIdDesc([newRecord, ...database]);
    safeLocalStorage.setItem("concessions_permit_db", JSON.stringify(updated));
    safeLocalStorage.setItem("concessions_permit_db_last_modified", Date.now().toString());
    onDatabaseChange(updated);

    setShowNewEntryModal(false);
    setFeedbackMsg({
      type: "success",
      text: `Successfully created Record Form ID ${nextFormId}!`
    });

    // Reset inputs
    setNewFormWard("");
    setNewFormVrm("");
    setNewFormDriverName("");
    setNewFormPhone("");
    setNewFormEmail("");
    setNewFormVoucherCode("-");
    setNewFormStartTime("");
  };

  const filteredDropdownRecords = React.useMemo(() => {
    if (!debouncedSearchQuery.trim()) return [];
    const q = debouncedSearchQuery.toLowerCase();
    return sortedDatabase.filter(r => {
      const cleanFormId = formatFormId(r.formId !== undefined ? r.formId : r.id);
      return (
        cleanFormId.includes(debouncedSearchQuery) ||
        (r.formId && String(r.formId).includes(debouncedSearchQuery)) ||
        r.driverName.toLowerCase().includes(q) ||
        r.vrm.toLowerCase().includes(q) ||
        r.hospital.toLowerCase().includes(q) ||
        r.ward.toLowerCase().includes(q)
      );
    }).slice(0, 8);
  }, [sortedDatabase, debouncedSearchQuery]);

  const filteredTableRecords = React.useMemo(() => {
    let result = sortedDatabase;

    if (dateRangeFilter && dateRangeFilter !== 'all') {
      const days = dateRangeFilter === '7days' ? 7 : 30;
      result = result.filter(r => {
        const iso = getRecordSubmittedDateISO(r);
        if (iso) {
          const subDate = new Date(iso);
          const today = new Date(processingDate || getTodayISO());
          const diffTime = today.getTime() - subDate.getTime();
          const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
          if (diffDays < 0 || diffDays > days) return false;
        }
        return true;
      });
    }

    if (!debouncedSearchQuery.trim()) return result;
    const q = debouncedSearchQuery.toLowerCase();
    return result.filter(r => {
      const cleanFormId = formatFormId(r.formId !== undefined ? r.formId : r.id);
      return (
        cleanFormId.includes(debouncedSearchQuery) ||
        (r.formId && String(r.formId).includes(debouncedSearchQuery)) ||
        r.driverName.toLowerCase().includes(q) ||
        r.vrm.toLowerCase().includes(q) ||
        r.hospital.toLowerCase().includes(q) ||
        r.ward.toLowerCase().includes(q) ||
        (r.email && r.email.toLowerCase().includes(q)) ||
        (r.voucherCode && r.voucherCode.toLowerCase().includes(q))
      );
    });
  }, [sortedDatabase, debouncedSearchQuery, dateRangeFilter, processingDate]);

  const effectiveTotalCount = totalRecordsCount && totalRecordsCount > 0 ? totalRecordsCount : database.length;
  const isFilteredBySearch = Boolean(debouncedSearchQuery.trim());
  const displayCount = (dateRangeFilter === 'all' && !isFilteredBySearch)
    ? effectiveTotalCount
    : filteredTableRecords.length;

  return (
    <aside ref={panelRef} className="data-sidebar h-full">
      <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept=".xlsx,.xls" className="hidden" />
      <input type="file" ref={vouchersFileInputRef} onChange={handleVouchersFileUpload} accept=".csv,.txt" className="hidden" />

      {feedbackMsg && <div className={`sidebar-feedback ${feedbackMsg.type}`}><span>{feedbackMsg.type === "success" ? "✓" : "!"}</span><span>{feedbackMsg.text}</span><button type="button" onClick={() => setFeedbackMsg(null)}><X /></button></div>}

      {voucherValidationErrors && voucherValidationErrors.length > 0 && (
        <VoucherImportBlockedModal
          isOpen={true}
          onClose={() => {
            setVoucherValidationErrors(null);
            setBlockedFileName("");
          }}
          errors={voucherValidationErrors}
          fileName={blockedFileName}
        />
      )}
    </aside>
  );

}));
