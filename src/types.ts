export type StorageMode = "cloud" | "offline";

export interface PermitData {
  id?: string;
  formId?: string | number;
  title: string;
  site: string;
  name: string;
  vrm: string;
  validFrom: string;
  validTo: string;
  ward: string;
  qrOverride: string;
  voucherCodesText: string;
  phone: string;
  email: string;
  todayDate?: string;
  dateRequired?: string;
  department?: string;
  startTime?: string;
  createdAt?: string;
  created_at?: string;
  completionTime?: string;
  status?: string;
  emailType?: "SEND_CONCESSION" | "RESEND_CONCESSION" | string;
  isResend?: boolean;
  emailTemplate?: "new" | "replacement";
  replacementCode?: string;
  voucherCode?: string;
  prePaidCode?: string;
  qrCode?: string;
  serialNumber?: string;
  voucher?: string;
  code?: string;
  driverName?: string;
  driverEmail?: string;
  isCancelled?: boolean;
  isDispatched?: boolean;
  dispatchedAt?: string;
  hasOriginalVoucher?: boolean;
  originalVoucherCode?: string;
  processingDate?: string;
  submissionDate?: string;
  cancellationReason?: "DUPLICATE_VRM" | "BLOCKLIST" | "EXPIRED" | "MANUAL" | string;
}

export const HOSPITAL_SITES = [
  "Newham Hospital",
  "Whipps Cross Hospital"
] as const;
