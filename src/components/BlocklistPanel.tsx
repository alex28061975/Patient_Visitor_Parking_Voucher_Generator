import React, { useState, useEffect, useMemo } from "react";
import { 
  ShieldAlert, 
  Search, 
  Plus, 
  Trash2, 
  X, 
  AlertTriangle, 
  Check, 
  Car, 
  Filter,
  Download,
  Building2,
  Calendar,
  User,
  Ticket
} from "lucide-react";
import { 
  BlocklistItem, 
  getBlocklist, 
  saveBlocklist, 
  addBlocklistItem, 
  removeBlocklistItem, 
  normalizeVrm 
} from "../lib/blocklist";
import { CsvPermitRecord, formatFormId, toTitleCase } from "../utils/csvParser";

interface BlocklistPanelProps {
  isOpen: boolean;
  onClose: () => void;
  database?: CsvPermitRecord[];
}

function BlocklistPanelComponent({ isOpen, onClose, database = [] }: BlocklistPanelProps) {
  const [items, setItems] = useState<BlocklistItem[]>(() => getBlocklist());
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [showAddForm, setShowAddForm] = useState<boolean>(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // Form state for adding new blocked vehicle
  const [formVrm, setFormVrm] = useState<string>("");
  const [formReason, setFormReason] = useState<string>("");
  const [formDriverName, setFormDriverName] = useState<string>("");
  const [formHospital, setFormHospital] = useState<string>("");
  const [formWard, setFormWard] = useState<string>("");
  const [formDateRequired, setFormDateRequired] = useState<string>("");
  const [formExpiryDate, setFormExpiryDate] = useState<string>("");
  const [formPhone, setFormPhone] = useState<string>("");
  const [formEmail, setFormEmail] = useState<string>("");
  const [formVoucherCode, setFormVoucherCode] = useState<string>("BLOCKED");
  const [formFormId, setFormFormId] = useState<string>("");

  useEffect(() => {
    const handleUpdate = () => {
      setItems(getBlocklist());
    };
    window.addEventListener("blocklist_updated", handleUpdate);
    return () => window.removeEventListener("blocklist_updated", handleUpdate);
  }, []);

  useEffect(() => {
    if (isOpen) {
      setItems(getBlocklist());
    }
  }, [isOpen]);

  const showNotification = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3000);
  };

  // Filtered blocklist items
  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items;
    const q = searchQuery.toLowerCase().trim();
    return items.filter((item) => {
      return (
        (item.vrm && item.vrm.toLowerCase().includes(q)) ||
        (item.driverName && item.driverName.toLowerCase().includes(q)) ||
        (item.reason && item.reason.toLowerCase().includes(q)) ||
        (item.hospitalSite && item.hospitalSite.toLowerCase().includes(q)) ||
        (item.wardDept && item.wardDept.toLowerCase().includes(q)) ||
        (item.email && item.email.toLowerCase().includes(q)) ||
        (item.formId && String(item.formId).toLowerCase().includes(q))
      );
    });
  }, [items, searchQuery]);

  // Autofill from existing database records when VRM is entered
  const handleVrmChange = (val: string) => {
    setFormVrm(val.toUpperCase());
    const clean = normalizeVrm(val);
    if (clean.length >= 4 && database && database.length > 0) {
      const match = database.find(
        (r) => normalizeVrm(r.vrm) === clean
      );
      if (match) {
        if (!formDriverName && match.driverName) setFormDriverName(match.driverName);
        if (!formHospital && match.hospital) setFormHospital(match.hospital);
        if (!formWard && match.ward) setFormWard(match.ward);
        if (!formPhone && match.phone) setFormPhone(match.phone);
        if (!formEmail && match.email) setFormEmail(match.email);
        if (!formDateRequired && match.dateRequired) setFormDateRequired(match.dateRequired);
        if (!formExpiryDate && match.dateExpiry) setFormExpiryDate(match.dateExpiry);
        if (!formFormId && (match.formId !== undefined || match.id !== undefined)) {
          setFormFormId(String(match.formId !== undefined ? match.formId : match.id));
        }
      }
    }
  };

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formVrm.trim()) {
      showNotification("⚠️ Please enter a valid VRM (vehicle registration).");
      return;
    }
    if (!formReason.trim()) {
      showNotification("⚠️ Please enter a reason for blocking this vehicle.");
      return;
    }

    const cleanVrm = formVrm.trim().toUpperCase();
    // Check if already blocked
    const existing = items.find((i) => normalizeVrm(i.vrm) === normalizeVrm(cleanVrm));
    if (existing) {
      showNotification(`⚠️ VRM ${cleanVrm} is already on the blocklist.`);
      return;
    }

    addBlocklistItem({
      vrm: cleanVrm,
      reason: formReason.trim(),
      driverName: formDriverName.trim() || undefined,
      hospitalSite: formHospital.trim() || undefined,
      wardDept: formWard.trim() || undefined,
      dateRequired: formDateRequired.trim() || undefined,
      expiryDate: formExpiryDate.trim() || undefined,
      phone: formPhone.trim() || undefined,
      email: formEmail.trim() || undefined,
      voucherCode: formVoucherCode.trim() || "BLOCKED",
      formId: formFormId.trim() || undefined
    });

    setItems(getBlocklist());
    showNotification(`✅ Added ${cleanVrm} to silent blocklist.`);

    // Reset form
    setFormVrm("");
    setFormReason("");
    setFormDriverName("");
    setFormHospital("");
    setFormWard("");
    setFormDateRequired("");
    setFormExpiryDate("");
    setFormPhone("");
    setFormEmail("");
    setFormFormId("");
    setShowAddForm(false);
  };

  const handleRemove = (id: string, vrm: string) => {
    if (window.confirm(`Are you sure you want to remove VRM ${vrm} from the blocklist?`)) {
      removeBlocklistItem(id);
      setItems(getBlocklist());
      showNotification(`🗑️ Removed ${vrm} from blocklist.`);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[999] bg-slate-950/60 dark:bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl w-full max-w-6xl max-h-[90vh] flex flex-col overflow-hidden text-slate-800 dark:text-slate-200">
        
        {/* Header Bar */}
        <div className="p-4 bg-slate-50 dark:bg-slate-950/70 border-b border-slate-200 dark:border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-800/80 flex items-center justify-center text-rose-600 dark:text-rose-400 shrink-0">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-slate-900 dark:text-white tracking-tight">
                  Concessions Silent Blocklist
                </h2>
                <span className="bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800/60 font-mono font-bold px-2 py-0.5 rounded-full text-xs">
                  {items.length} Blocked
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Vehicles on this list are silently blocked from QR code generation during dispatch.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setShowAddForm(!showAddForm)}
              className="flex items-center gap-1.5 px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded-lg transition-all shadow-xs cursor-pointer active:scale-95"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{showAddForm ? "Cancel Add" : "Block New VRM"}</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="p-2 text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-200/60 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
              title="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Toast feedback */}
        {toastMsg && (
          <div className="bg-slate-100 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 px-4 py-2 text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-2 animate-in fade-in">
            <span>{toastMsg}</span>
          </div>
        )}

        {/* Collapsible Add Entry Form */}
        {showAddForm && (
          <form 
            onSubmit={handleAddSubmit}
            className="p-4 bg-slate-50/80 dark:bg-slate-950/90 border-b border-slate-200 dark:border-slate-800 grid grid-cols-1 md:grid-cols-4 gap-3 text-xs animate-in slide-in-from-top-2 duration-200"
          >
            <div className="space-y-1">
              <label className="font-bold text-slate-700 dark:text-slate-300 flex items-center gap-1">
                <span>VRM / Registration *</span>
              </label>
              <input
                type="text"
                value={formVrm}
                onChange={(e) => handleVrmChange(e.target.value)}
                placeholder="e.g. AU67 HCZ"
                required
                className="w-full px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white font-mono font-bold uppercase focus:outline-none focus:border-rose-500"
              />
            </div>

            <div className="space-y-1">
              <label className="font-bold text-slate-700 dark:text-slate-300">Driver Name</label>
              <input
                type="text"
                value={formDriverName}
                onChange={(e) => setFormDriverName(e.target.value)}
                placeholder="e.g. Sarah Connor"
                className="w-full px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:outline-none focus:border-rose-500"
              />
            </div>

            <div className="space-y-1 md:col-span-2">
              <label className="font-bold text-slate-700 dark:text-slate-300">Block Reason *</label>
              <input
                type="text"
                value={formReason}
                onChange={(e) => setFormReason(e.target.value)}
                placeholder="e.g. Duplicate active permits / Abuse of concessions"
                required
                className="w-full px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:outline-none focus:border-rose-500"
              />
            </div>

            <div className="space-y-1">
              <label className="font-bold text-slate-600 dark:text-slate-400">Hospital Site</label>
              <input
                type="text"
                value={formHospital}
                onChange={(e) => setFormHospital(e.target.value)}
                placeholder="e.g. Whipps Cross Hospital"
                className="w-full px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-300 focus:outline-none focus:border-rose-500"
              />
            </div>

            <div className="space-y-1">
              <label className="font-bold text-slate-600 dark:text-slate-400">Ward / Department</label>
              <input
                type="text"
                value={formWard}
                onChange={(e) => setFormWard(e.target.value)}
                placeholder="e.g. Emergency Care"
                className="w-full px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-300 focus:outline-none focus:border-rose-500"
              />
            </div>

            <div className="space-y-1">
              <label className="font-bold text-slate-600 dark:text-slate-400">Date Required</label>
              <input
                type="date"
                value={formDateRequired}
                onChange={(e) => setFormDateRequired(e.target.value)}
                className="w-full px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-300 focus:outline-none focus:border-rose-500 font-mono"
              />
            </div>

            <div className="space-y-1">
              <label className="font-bold text-slate-600 dark:text-slate-400">Expiry Date</label>
              <input
                type="date"
                value={formExpiryDate}
                onChange={(e) => setFormExpiryDate(e.target.value)}
                className="w-full px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-300 focus:outline-none focus:border-rose-500 font-mono"
              />
            </div>

            <div className="space-y-1">
              <label className="font-bold text-slate-600 dark:text-slate-400">Phone</label>
              <input
                type="text"
                value={formPhone}
                onChange={(e) => setFormPhone(e.target.value)}
                placeholder="07700900000"
                className="w-full px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-300 focus:outline-none focus:border-rose-500"
              />
            </div>

            <div className="space-y-1">
              <label className="font-bold text-slate-600 dark:text-slate-400">Email</label>
              <input
                type="email"
                value={formEmail}
                onChange={(e) => setFormEmail(e.target.value)}
                placeholder="driver@example.com"
                className="w-full px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-300 focus:outline-none focus:border-rose-500"
              />
            </div>

            <div className="space-y-1">
              <label className="font-bold text-slate-600 dark:text-slate-400">Form ID</label>
              <input
                type="text"
                value={formFormId}
                onChange={(e) => setFormFormId(e.target.value)}
                placeholder="e.g. 1311"
                className="w-full px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-300 focus:outline-none focus:border-rose-500 font-mono"
              />
            </div>

            <div className="flex items-end md:col-span-1">
              <button
                type="submit"
                className="w-full py-2 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-lg transition-all cursor-pointer shadow-xs"
              >
                Confirm Block
              </button>
            </div>
          </form>
        )}

        {/* Search Bar */}
        <div className="p-3 bg-slate-50 dark:bg-slate-900/60 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
          <div className="relative w-full md:w-80">
            <Search className="w-4 h-4 text-slate-400 dark:text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search VRM, Driver, Reason, Site..."
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded-lg text-slate-800 dark:text-slate-200 focus:outline-none focus:border-rose-500"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 text-xs font-bold"
              >
                &times;
              </button>
            )}
          </div>

          <div className="text-xs text-slate-500 dark:text-slate-400 font-mono">
            <span>Showing {filteredItems.length} of {items.length} block rules</span>
          </div>
        </div>

        {/* Exact 12-Column Table Layout:
            [FORM ID] [HOSPITAL SITE] [WARD / DEPT] [DATE REQUIRED] [EXPIRY DATE] [VRM] [DRIVER NAME] [PHONE] [EMAIL] [VOUCHER CODE] [REASON] [ACTION]
        */}
        <div className="overflow-x-auto flex-1 max-h-[60vh] bg-white dark:bg-slate-950">
          <table className="min-w-[1200px] w-full text-left text-xs border-collapse table-auto">
            <thead className="bg-slate-100 dark:bg-slate-900/95 text-slate-700 dark:text-slate-300 font-bold sticky top-0 z-10 uppercase text-[10px] tracking-wider border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="p-3 whitespace-nowrap border-r border-slate-200/80 dark:border-slate-800/80">FORM ID</th>
                <th className="p-3 whitespace-nowrap border-r border-slate-200/80 dark:border-slate-800/80">HOSPITAL SITE</th>
                <th className="p-3 whitespace-nowrap border-r border-slate-200/80 dark:border-slate-800/80">WARD / DEPT</th>
                <th className="p-3 whitespace-nowrap border-r border-slate-200/80 dark:border-slate-800/80">DATE REQUIRED</th>
                <th className="p-3 whitespace-nowrap border-r border-slate-200/80 dark:border-slate-800/80">EXPIRY DATE</th>
                <th className="p-3 whitespace-nowrap border-r border-slate-200/80 dark:border-slate-800/80">VRM</th>
                <th className="p-3 whitespace-nowrap border-r border-slate-200/80 dark:border-slate-800/80">DRIVER NAME</th>
                <th className="p-3 whitespace-nowrap border-r border-slate-200/80 dark:border-slate-800/80">PHONE</th>
                <th className="p-3 whitespace-nowrap border-r border-slate-200/80 dark:border-slate-800/80">EMAIL</th>
                <th className="p-3 whitespace-nowrap border-r border-slate-200/80 dark:border-slate-800/80">VOUCHER CODE</th>
                <th className="p-3 whitespace-nowrap border-r border-slate-200/80 dark:border-slate-800/80">REASON</th>
                <th className="p-3 whitespace-nowrap text-center">ACTION</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-150 dark:divide-slate-800/60 font-mono text-[11px]">
              {filteredItems.length === 0 ? (
                <tr>
                  <td colSpan={12} className="p-8 text-center text-slate-400 dark:text-slate-500 font-sans">
                    No blocklist entries found. Use "Block New VRM" above to add rules.
                  </td>
                </tr>
              ) : (
                filteredItems.map((item, idx) => (
                  <tr
                    key={item.id || idx}
                    className="hover:bg-rose-50/60 dark:hover:bg-rose-950/20 transition-colors"
                  >
                    {/* 1. FORM ID */}
                    <td className="p-3 font-bold text-rose-600 dark:text-rose-400 whitespace-nowrap border-r border-slate-150 dark:border-slate-800/60">
                      <span className="bg-rose-50 dark:bg-rose-950/60 px-1.5 py-0.5 rounded border border-rose-200 dark:border-rose-800/60">
                        {item.formId ? `#${formatFormId(item.formId)}` : "-"}
                      </span>
                    </td>

                    {/* 2. HOSPITAL SITE */}
                    <td className="p-3 font-sans text-slate-700 dark:text-slate-300 whitespace-nowrap border-r border-slate-150 dark:border-slate-800/60">
                      {item.hospitalSite || "-"}
                    </td>

                    {/* 3. WARD / DEPT */}
                    <td className="p-3 font-sans text-slate-700 dark:text-slate-300 whitespace-nowrap border-r border-slate-150 dark:border-slate-800/60">
                      {item.wardDept || "-"}
                    </td>

                    {/* 4. DATE REQUIRED */}
                    <td className="p-3 text-slate-700 dark:text-slate-300 whitespace-nowrap border-r border-slate-150 dark:border-slate-800/60 font-mono">
                      {item.dateRequired || "-"}
                    </td>

                    {/* 5. EXPIRY DATE */}
                    <td className="p-3 text-slate-700 dark:text-slate-300 whitespace-nowrap border-r border-slate-150 dark:border-slate-800/60 font-mono">
                      {item.expiryDate || "-"}
                    </td>

                    {/* 6. VRM */}
                    <td className="p-3 font-bold text-slate-900 dark:text-white uppercase tracking-wider whitespace-nowrap border-r border-slate-150 dark:border-slate-800/60">
                      <span className="bg-rose-50 dark:bg-rose-950/80 text-rose-700 dark:text-rose-300 px-2 py-0.5 rounded border border-rose-200 dark:border-rose-800/80 font-mono font-extrabold text-[12px]">
                        {item.vrm}
                      </span>
                    </td>

                    {/* 7. DRIVER NAME */}
                    <td className="p-3 font-sans font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap border-r border-slate-150 dark:border-slate-800/60">
                      {item.driverName ? toTitleCase(item.driverName) : "-"}
                    </td>

                    {/* 8. PHONE */}
                    <td className="p-3 text-slate-500 dark:text-slate-400 whitespace-nowrap border-r border-slate-150 dark:border-slate-800/60">
                      {item.phone || "-"}
                    </td>

                    {/* 9. EMAIL */}
                    <td className="p-3 text-slate-500 dark:text-slate-400 whitespace-nowrap border-r border-slate-150 dark:border-slate-800/60">
                      {item.email || "-"}
                    </td>

                    {/* 10. VOUCHER CODE */}
                    <td className="p-3 whitespace-nowrap border-r border-slate-150 dark:border-slate-800/60">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[10.5px] font-bold border border-rose-200 dark:border-rose-900/80 bg-rose-50 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300">
                        {item.voucherCode || "BLOCKED"}
                      </span>
                    </td>

                    {/* 11. REASON */}
                    <td className="p-3 font-sans text-slate-600 dark:text-slate-300 max-w-xs truncate border-r border-slate-150 dark:border-slate-800/60" title={item.reason}>
                      <span className="text-rose-700 dark:text-rose-300/90 font-medium">
                        {item.reason || "Administrative block"}
                      </span>
                    </td>

                    {/* 12. ACTION */}
                    <td className="p-3 text-center whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => handleRemove(item.id, item.vrm)}
                        className="px-2.5 py-1 bg-red-50 hover:bg-red-100 dark:bg-red-950/60 dark:hover:bg-red-900/80 text-red-600 dark:text-red-300 border border-red-200 dark:border-red-800/60 text-[10px] font-bold uppercase tracking-wider rounded transition-all flex items-center gap-1 mx-auto cursor-pointer shadow-xs active:scale-95"
                        title="Unblock / Remove vehicle from blocklist"
                      >
                        <Trash2 className="w-3 h-3 text-red-600 dark:text-red-400" />
                        <span>Unblock</span>
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Footer Summary */}
        <div className="p-3 bg-slate-50 dark:bg-slate-950 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400 flex items-center justify-between font-sans">
          <span>Active silent block enforcement: {items.length} registration marks</span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 font-bold rounded-lg transition-colors cursor-pointer text-xs"
          >
            Done
          </button>
        </div>

      </div>
    </div>
  );
}
export const BlocklistPanel = React.memo(BlocklistPanelComponent);
