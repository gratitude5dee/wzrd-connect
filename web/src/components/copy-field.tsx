import type { ReactNode } from "react";

import { useTranslate } from "@embra/i18n/react";
import { useClipboard } from "foxact/use-clipboard";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface CopyButtonProps {
  value: string;
  /** Tooltip + aria-label, e.g. "Copy token". */
  label: string;
  /** Shown briefly after a successful copy. */
  copiedLabel?: string;
}

// One-line copy affordance for credentials, URLs and ids: copies `value` and
// shows a check for a moment so the copy is visible.
export function CopyButton(props: CopyButtonProps): ReactNode {
  const t = useTranslate();
  const { copy, copied } = useClipboard();
  const copiedText = props.copiedLabel ?? t("common.copied");

  // Own provider so the button also works in pages (and tests) rendered
  // outside the app shell's TooltipProvider.
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            aria-label={copied ? copiedText : props.label}
            onClick={() => void copy(props.value)}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{copied ? copiedText : props.label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

interface CopyFieldProps {
  label: string;
  value: string;
  /** Tooltip + aria-label for the copy affordance; defaults to the field label. */
  copyLabel?: string;
}

// A read-only credential/URL field with an attached copy button — the pattern
// every secret-adjacent value the console displays shares.
export function CopyField(props: CopyFieldProps): ReactNode {
  const t = useTranslate();
  return (
    <div className="field">
      <Label>
        <span>{props.label}</span>
      </Label>
      <div className="copy-field">
        <Input className="font-mono text-xs" value={props.value} readOnly />
        <CopyButton value={props.value} label={props.copyLabel ?? `${t("common.copy")} ${props.label}`} />
      </div>
    </div>
  );
}
