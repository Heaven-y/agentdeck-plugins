// 共用控件采用中性主操作、细边框、统一状态层与明确焦点；状态颜色只用于对应反馈。

const BUTTON_BASE =
  'ui-button inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg px-3.5 text-[13px] font-medium leading-5 transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-40';

const BUTTON_VARIANTS = {
  primary: 'bg-accent text-accent-foreground shadow-xs hover:bg-accent/90 active:bg-accent/80',
  outline: 'border border-border-strong bg-background text-foreground hover:bg-control-hover active:bg-control-active',
  ghost: 'text-muted-foreground hover:bg-control-hover hover:text-foreground active:bg-control-active',
  danger:
    'border border-border-danger bg-surface-danger/60 text-destructive-foreground hover:bg-surface-danger active:bg-destructive/20',
} as const;

export const buttonClass = (variant: keyof typeof BUTTON_VARIANTS = 'outline') =>
  `${BUTTON_BASE} ${BUTTON_VARIANTS[variant]}`;

export const iconButtonClass =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-control-hover hover:text-foreground focus-visible:outline-interactive disabled:cursor-not-allowed disabled:opacity-40';

export const inputClass =
  'ui-control min-w-0 w-full rounded-lg border border-border-strong bg-background px-3 py-2 text-[13px] leading-5 text-foreground placeholder:text-muted-foreground aria-invalid:border-destructive focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-inset focus-visible:ring-interactive/85 disabled:opacity-50';

export const popoverClass = 'ui-popover z-50 p-1.5 text-foreground';

export const menuItemClass =
  'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] leading-5 outline-none transition-colors data-active-item:bg-control-hover data-active-item:text-foreground aria-disabled:cursor-not-allowed aria-disabled:opacity-45';
