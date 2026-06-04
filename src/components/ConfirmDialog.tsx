import * as AlertDialog from "@radix-ui/react-alert-dialog";

import { cn } from "@/lib/cn";

/**
 * In-app replacement for window.confirm. Switch-access / keyboard friendly,
 * styled to match the Slate & Sun cards. Coral confirm button when
 * `destructive` so destructive choices stay visually distinct.
 *
 * Controlled — caller owns `open` so the consumer can keep the trigger that
 * opened it as a normal button (avoiding the Radix Trigger sandwich for
 * cases where the action button lives elsewhere in the row).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-[var(--ink)]/40 backdrop-blur-sm",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
          )}
        />
        <AlertDialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2",
            "rounded-2xl border border-[var(--line)] bg-white p-6 shadow-xl",
            "focus:outline-none",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          )}
        >
          <AlertDialog.Title className="text-lg font-semibold text-[var(--ink)]">
            {title}
          </AlertDialog.Title>
          {description && (
            <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-[var(--ink-soft)]">
              {description}
            </AlertDialog.Description>
          )}
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <AlertDialog.Cancel
              className={cn(
                "inline-flex min-h-[40px] items-center justify-center rounded-lg border border-[var(--line)] bg-white px-4 text-sm font-medium text-[var(--ink)]",
                "hover:bg-[var(--sand-2)]/60 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2",
              )}
            >
              {cancelLabel}
            </AlertDialog.Cancel>
            <AlertDialog.Action
              onClick={(event) => {
                // Let Radix close the dialog as normal, but run the consumer's
                // confirm handler regardless of whether it's async — Radix
                // already calls preventDefault if we want to keep it open,
                // so we explicitly don't.
                void onConfirm();
                event.currentTarget.blur();
              }}
              className={cn(
                "inline-flex min-h-[40px] items-center justify-center rounded-lg px-4 text-sm font-semibold",
                "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-offset-2",
                destructive
                  ? "bg-[var(--coral)] text-white hover:opacity-90 focus-visible:ring-[var(--coral)]"
                  : "bg-[var(--ink)] text-white hover:opacity-90 focus-visible:ring-[var(--accent)]",
              )}
            >
              {confirmLabel}
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
