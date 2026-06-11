## Frontend Glassmorphism Style Guide

This guide standardizes the “glass” look (translucent backgrounds + backdrop blur) across the app for both Light and Dark modes, ensuring consistent visuals, readability, and graceful degradation.

### Design Principles
- **Translucent surface**: semi-transparent fill + `backdrop-blur-*`.
- **Subtle border**: low-contrast stroke to separate panel from background.
- **Soft shadow**: add depth without overpowering content.
- **Theme-aware**: adjust opacity and shadow between light/dark modes.
- **Graceful fallback**: use `supports-[backdrop-filter]:` to enhance when supported; keep an acceptable base fill otherwise.

### Base Recipe (Tailwind utilities)
- Shared
  - Shape: `rounded-2xl` or `rounded-3xl`
  - Border: `border` + low-contrast color
  - Blur: `backdrop-blur-md` (or `backdrop-blur-lg/2xl` for large dialogs)
  - Enhancement: `supports-[backdrop-filter]:bg-*` for better fill with blur
  - Shadow: from `shadow-md` to custom rgba shadows

- Light mode
  - Background: `bg-white/50` to `bg-white/80`
  - Border: `border-slate-200` or `border-white/50` on very light fills
  - Shadow: `shadow-md` or `shadow-[0_20px_60px_rgba(15,23,42,0.18)]`
  - Enhancement: `supports-[backdrop-filter]:bg-white/50`

- Dark mode
  - Background: `dark:bg-white/5` to `dark:bg-slate-900/40`
  - Border: `dark:border-white/10` to `dark:border-white/20`
  - Shadow: `dark:shadow-[0_18px_40px_rgba(15,23,42,0.6)]`
  - Enhancement: `supports-[backdrop-filter]:dark:bg-slate-900/45` (or `dark:bg-white/5` for ultra-light glass)

### Recommended Class Templates

#### Panel / Container (unified)
```tsx
<div
  className={cn(
    "rounded-2xl border backdrop-blur-md",
    "bg-white/50 border-slate-200 shadow-md supports-[backdrop-filter]:bg-white/50",
    "dark:bg-white/5 dark:border-white/10 dark:shadow-[0_18px_40px_rgba(15,23,42,0.6)] dark:supports-[backdrop-filter]:bg-slate-900/45"
  )}
/>
```

#### Dialog Content (full-glass)
```tsx
<div
  className={cn(
    "overflow-hidden rounded-3xl supports-[backdrop-filter]:backdrop-blur-lg",
    "border border-slate-200 bg-white/50 text-slate-900 shadow-[0_20px_60px_rgba(15,23,42,0.18)] supports-[backdrop-filter]:bg-white/50",
    "dark:border-white/15 dark:bg-[#0a0e27]/85 dark:text-white dark:shadow-[0_30px_80px_rgba(8,7,60,0.55)] dark:supports-[backdrop-filter]:bg-[#0a0e27]/60"
  )}
/>
```

#### Sticky Header / Toolbar (subtle glass)
```tsx
<div
  className={cn(
    "rounded-lg border backdrop-blur-md shadow-sm",
    "bg-white/50 border-slate-300 supports-[backdrop-filter]:bg-white/60",
    "dark:bg-white/10 dark:border-white/20 dark:supports-[backdrop-filter]:bg-white/10"
  )}
/>
```

#### Floating Button / Menu (compact glass)
```tsx
<Button
  className={cn(
    "h-9 px-3 gap-2 backdrop-blur-md transition-all shadow-md",
    "bg-white/50 border border-slate-200 hover:bg-white/70 hover:border-slate-300 text-slate-900",
    "dark:bg-white/10 dark:border-white/20 dark:hover:bg-white/20 dark:hover:border-white/30 dark:text-white"
  )}
/>
```

### Opacity and Blur Guidance
- Blur: `backdrop-blur-md` for dense content; `lg/2xl` for large overlays (e.g., dialogs).
- Light backgrounds: typically `bg-white/50`; increase to `bg-white/70–80` on busy backdrops.
- Dark backgrounds: `dark:bg-white/5–10` for subtle glass; use `dark:bg-slate-900/40` when stronger separation is needed.

### Borders and Dividers
- Light: `border-slate-200`, or `border-white/50` on very light panes.
- Dark: `dark:border-white/10–20`.
- Use `border-b` inside panels with matching color/opacity for internal sections.

### Shadows
- Prefer soft, wide shadows:
  - Light: `shadow-md` or `shadow-[0_20px_60px_rgba(15,23,42,0.18)]`
  - Dark: `dark:shadow-[0_18px_40px_rgba(15,23,42,0.6)]`
- For floating UI, use `shadow-[0_8px_24px_rgba(15,23,42,0.4)]` to enhance lift.

### Accessibility (Contrast)
- Text contrast:
  - Light glass: `text-slate-900`
  - Dark glass: `dark:text-white`
- For text-heavy areas, slightly increase background opacity or add a subtle solid underlay.
- Avoid overly transparent buttons on noisy backgrounds; provide clear `hover:bg-*` states.

### Performance and Fallbacks
- Backdrop blur is GPU-expensive:
  - Apply `backdrop-blur-*` only to necessary containers.
  - Use `supports-[backdrop-filter]:` to enhance; rely on base `bg-*` when unsupported.
- Avoid stacking multiple `backdrop-blur-*` layers in the same region.

### Common Patterns in the Codebase (reference)
- Dialogs: `supports-[backdrop-filter]:backdrop-blur-lg` + theme-specific fills and shadows.
- Sidebars/Toolbars: Light `bg-white/50`; Dark `dark:bg-slate-900/40` + `border-white/20`.
- Panels/Charts: `border` + `backdrop-blur-md` + theme-specific background and shadow.

### Quick Checklists
- Light mode
  - Background: `bg-white/50–80`
  - Border: `border-slate-200` or `border-white/50`
  - Text: `text-slate-900`
  - Shadow: `shadow-md` or custom rgba depth
  - Enhancement: `supports-[backdrop-filter]:bg-white/50`

- Dark mode
  - Background: `dark:bg-white/5–10` or `dark:bg-slate-900/40`
  - Border: `dark:border-white/10–20`
  - Text: `dark:text-white`
  - Shadow: `dark:shadow-[0_18px_40px_rgba(15,23,42,0.6)]`
  - Enhancement: `supports-[backdrop-filter]:dark:bg-slate-900/45`

---

If further unification is desired, consider adding a reusable `Glass` component or a Tailwind plugin utility that encapsulates the templates above to reduce repeated class stacks.


