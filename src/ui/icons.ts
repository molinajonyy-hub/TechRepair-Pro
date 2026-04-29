/**
 * Registro centralizado de iconos — TechRepair Pro
 * Todas las páginas deben importar iconos desde aquí, no directamente desde lucide-react.
 * Esto garantiza consistencia y permite cambiar la librería desde un solo lugar.
 */
export {
  // ── Acciones CRUD ────────────────────────────────────────────────────────────
  Plus          as AddIcon,
  PlusCircle    as AddCircleIcon,
  ClipboardPlus as NewOrderIcon,
  Pencil        as EditIcon,
  Trash2        as DeleteIcon,
  Save          as SaveIcon,
  X             as CancelIcon,
  Eye           as ViewIcon,
  EyeOff        as HideIcon,
  Copy          as DuplicateIcon,
  Archive       as ArchiveIcon,
  RotateCcw     as RestoreIcon,

  // ── Navegación ────────────────────────────────────────────────────────────────
  ChevronLeft   as BackIcon,
  ChevronRight  as ForwardIcon,
  ChevronDown   as ExpandIcon,
  ChevronUp     as CollapseIcon,
  ArrowLeft     as ArrowBackIcon,
  ArrowRight    as ArrowForwardIcon,
  ExternalLink  as OpenExternalIcon,

  // ── Búsqueda y filtros ────────────────────────────────────────────────────────
  Search        as SearchIcon,
  Filter        as FilterIcon,
  SlidersHorizontal as FilterAdvancedIcon,
  RefreshCw     as RefreshIcon,

  // ── Documentos ────────────────────────────────────────────────────────────────
  Printer       as PrintIcon,
  Download      as DownloadIcon,
  Upload        as UploadIcon,
  FileText      as InvoiceIcon,
  File          as FileIcon,
  Paperclip     as AttachmentIcon,

  // ── Entidades del negocio ─────────────────────────────────────────────────────
  User          as ClientIcon,
  UserPlus      as NewClientIcon,
  Users         as ClientsIcon,
  Package       as ProductIcon,
  PackagePlus   as NewProductIcon,
  Boxes         as InventoryIcon,
  Wrench        as RepairIcon,
  ClipboardList as OrderIcon,
  Truck         as SupplierIcon,
  Tag           as OfferIcon,
  Receipt       as ReceiptIcon,
  ReceiptText   as ExpenseReceiptIcon,
  ShieldCheck   as WarrantyIcon,

  // ── Finanzas ──────────────────────────────────────────────────────────────────
  Wallet        as FinanceIcon,
  WalletCards   as AvailableIcon,
  CreditCard    as PaymentIcon,
  Banknote      as CashIcon,
  TrendingUp    as RevenueIcon,
  TrendingDown  as ExpenseIcon,
  DollarSign    as CurrencyIcon,
  PiggyBank     as CajaIcon,
  BarChart3     as ReportsIcon,
  LayoutDashboard as DashboardIcon,
  Cloud         as ExchangeRateIcon,
  Lock          as CloseLockIcon,

  // ── Estado y feedback ─────────────────────────────────────────────────────────
  CheckCircle   as SuccessIcon,
  AlertTriangle as AlertIcon,
  AlertCircle   as WarningCircleIcon,
  Info          as InfoIcon,
  XCircle       as ErrorIcon,
  Clock         as PendingIcon,
  Timer         as TimerIcon,

  // ── UI / Interfaz ─────────────────────────────────────────────────────────────
  Settings      as SettingsIcon,
  MoreHorizontal as MoreIcon,
  MoreVertical  as MoreVerticalIcon,
  Calendar      as CalendarIcon,
  Bell          as NotificationIcon,
  LogOut        as LogOutIcon,
  MessageCircle as MessageIcon,
  Phone         as PhoneIcon,
  Mail          as MailIcon,
  MapPin        as LocationIcon,
  Globe         as WebIcon,
  Link          as LinkIcon,
  Lock          as LockIcon,
  Unlock        as UnlockIcon,
  Power         as PowerIcon,
  Loader2       as LoadingIcon,
  Star          as StarIcon,
  Percent       as PercentIcon,

} from 'lucide-react'
