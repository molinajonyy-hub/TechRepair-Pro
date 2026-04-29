/**
 * Sistema de diseño — TechRepair Pro
 *
 * Importar desde aquí en todas las páginas:
 *   import { AppButton, AppModal, AppBadge, ... } from '../ui'
 *
 * NO importar directamente de src/ui/components/* en páginas de aplicación.
 */

// ── Iconos ────────────────────────────────────────────────────────────────────
export * from './icons'

// ── Botones ───────────────────────────────────────────────────────────────────
export { AppButton, AppIconButton }            from './components/AppButton'
export type { AppButtonProps, AppIconButtonProps, ButtonVariant, ButtonSize } from './components/AppButton'

// ── Modal ─────────────────────────────────────────────────────────────────────
export { AppModal, ModalSection, FormGrid }    from './components/AppModal'

// ── Inputs ────────────────────────────────────────────────────────────────────
export { AppInput, AppSelect, AppTextarea, AppSearchInput } from './components/AppInput'
export type { AppInputProps, AppSelectProps, AppTextareaProps, SelectOption } from './components/AppInput'

// ── Badges ────────────────────────────────────────────────────────────────────
export { AppBadge, AppStatusBadge }            from './components/AppBadge'
export type { BadgeVariant }                   from './components/AppBadge'

// ── Cards ─────────────────────────────────────────────────────────────────────
export { AppCard, AppStatCard }                from './components/AppCard'

// ── Page structure ────────────────────────────────────────────────────────────
export { AppPageHeader, AppSectionHeader, AppToolbar } from './components/AppPageHeader'

// ── Table ─────────────────────────────────────────────────────────────────────
export { AppTable, TableActions }              from './components/AppTable'
export type { TableColumn }                    from './components/AppTable'

// ── States ────────────────────────────────────────────────────────────────────
export { AppEmptyState, AppLoadingState, AppErrorState } from './components/AppEmptyState'

// ── Dialogs ───────────────────────────────────────────────────────────────────
export { AppConfirmDialog, useConfirm }        from './components/AppConfirmDialog'

// ── Tabs ──────────────────────────────────────────────────────────────────────
export { AppTabs }                             from './components/AppTabs'
export type { TabItem }                        from './components/AppTabs'
