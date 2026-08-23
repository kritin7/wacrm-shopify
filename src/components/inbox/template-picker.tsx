"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { MessageTemplate } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  ChevronRight,
  LayoutTemplate,
  Loader2,
} from "lucide-react";
import {
  extractVariableIndices,
  extractNamedVariables,
} from "@/lib/whatsapp/template-validators";
import { renderTemplateBodyText } from "@/lib/whatsapp/template-send-builder";
import { useTranslations } from "next-intl";

export interface TemplateSendValues {
  /**
   * POSITIONAL templates → `string[]` indexed by {{N}}. NAMED
   * templates → `Record<string, string>` keyed by {{name}}. Which
   * shape a template expects is `template.parameter_format` — must
   * match exactly what `template-send-builder.ts` expects, since the
   * send route passes this straight through to `buildSendComponents`.
   */
  body: string[] | Record<string, string>;
  headerText?: string;
  buttonParams?: Record<number, string>;
}

interface TemplatePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (template: MessageTemplate, values: TemplateSendValues) => void;
}

interface UrlButtonSlot {
  index: number;
  text: string;
  url: string;
}

interface NamedBodySlot {
  name: string;
  /** From `sample_values.body_text_named_params`, when synced. */
  placeholder?: string;
}

interface TemplateSlots {
  parameterFormat: "POSITIONAL" | "NAMED";
  /** POSITIONAL body variable indices, e.g. [1, 2]. Empty for NAMED. */
  bodyPositional: number[];
  /** NAMED body variable names, in first-appearance order. Empty for POSITIONAL. */
  bodyNamed: NamedBodySlot[];
  headerKind: "none" | "positional" | "named";
  /** Set only when headerKind === "named". */
  headerNamedVar: string | null;
  /**
   * URL button {{1}} suffixes. Per Meta's spec these are always
   * positional regardless of the body's parameter_format — abandoned_cart
   * proved a NAMED-body template can still have a POSITIONAL {{1}} in a
   * URL button — so this is detected independently of `parameterFormat`,
   * mirroring `buildButtonComponent` in template-send-builder.ts.
   */
  urlButtonSlots: UrlButtonSlot[];
}

/**
 * Templates may need values for: body variables (positional or named),
 * a text-header variable, and per-URL-button suffixes. Collect them
 * all so the send-message path doesn't 400 on missing parameters.
 *
 * `template.parameter_format` (migration 039) is the source of truth
 * for whether the body/header use {{N}} or {{name}} — not a regex
 * re-inference over body_text.
 */
function collectVariableSlots(template: MessageTemplate): TemplateSlots {
  const isNamed = template.parameter_format === "NAMED";

  const bodyPositional = isNamed
    ? []
    : extractVariableIndices(template.body_text);

  const namedExamples = new Map(
    (template.sample_values?.body_text_named_params ?? []).map((p) => [
      p.param_name,
      p.example,
    ]),
  );
  const bodyNamed: NamedBodySlot[] = isNamed
    ? extractNamedVariables(template.body_text).map((name) => ({
        name,
        placeholder: namedExamples.get(name),
      }))
    : [];

  let headerKind: TemplateSlots["headerKind"] = "none";
  let headerNamedVar: string | null = null;
  if (template.header_type === "text" && template.header_content) {
    if (isNamed) {
      const names = extractNamedVariables(template.header_content);
      if (names.length > 0) {
        headerKind = "named";
        headerNamedVar = names[0];
      }
    } else if (extractVariableIndices(template.header_content).length > 0) {
      headerKind = "positional";
    }
  }

  const urlButtonSlots: UrlButtonSlot[] = [];
  (template.buttons ?? []).forEach((b, i) => {
    if (b.type === "URL" && extractVariableIndices(b.url).length > 0) {
      urlButtonSlots.push({ index: i, text: b.text, url: b.url });
    }
  });

  return {
    parameterFormat: isNamed ? "NAMED" : "POSITIONAL",
    bodyPositional,
    bodyNamed,
    headerKind,
    headerNamedVar,
    urlButtonSlots,
  };
}

export function TemplatePicker({
  open,
  onOpenChange,
  onSelect,
}: TemplatePickerProps) {
  const t = useTranslations("Inbox.templatePicker");

  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<MessageTemplate | null>(null);
  const [positionalParams, setPositionalParams] = useState<string[]>([]);
  const [namedParams, setNamedParams] = useState<Record<string, string>>({});
  const [headerText, setHeaderText] = useState<string>("");
  const [buttonParams, setButtonParams] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    (async () => {
      setLoading(true);
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        if (!cancelled) {
          setTemplates([]);
          setLoading(false);
        }
        return;
      }

      // Scope by RLS (message_templates_select → is_account_member), NOT by
      // user_id. Templates are account-owned, so filtering on the caller's
      // user_id hid templates that a teammate created — leaving them unable
      // to send approved templates in a shared account.
      const { data, error } = await supabase
        .from("message_templates")
        .select("*")
        .eq("status", "APPROVED")
        .order("created_at", { ascending: false });

      if (cancelled) return;
      if (error) {
        console.error("Failed to fetch templates:", error);
        setTemplates([]);
      } else {
        setTemplates((data as MessageTemplate[]) ?? []);
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  function resetSelection() {
    setSelected(null);
    setPositionalParams([]);
    setNamedParams({});
    setHeaderText("");
    setButtonParams({});
  }

  function handleOpenChange(next: boolean) {
    if (!next) resetSelection();
    onOpenChange(next);
  }

  function pickTemplate(template: MessageTemplate) {
    const slots = collectVariableSlots(template);
    const noInputsNeeded =
      slots.bodyPositional.length === 0 &&
      slots.bodyNamed.length === 0 &&
      slots.headerKind === "none" &&
      slots.urlButtonSlots.length === 0;
    if (noInputsNeeded) {
      onSelect(template, {
        body: slots.parameterFormat === "NAMED" ? {} : [],
      });
      handleOpenChange(false);
      return;
    }
    setSelected(template);
    setPositionalParams(new Array(slots.bodyPositional.length).fill(""));
    setNamedParams({});
    setHeaderText("");
    setButtonParams({});
  }

  const slots = useMemo(
    () => (selected ? collectVariableSlots(selected) : null),
    [selected],
  );

  function confirm() {
    if (!selected || !slots) return;
    const values: TemplateSendValues = {
      body: slots.parameterFormat === "NAMED" ? namedParams : positionalParams,
    };
    if (headerText.trim()) values.headerText = headerText.trim();
    if (Object.keys(buttonParams).length > 0) {
      values.buttonParams = Object.fromEntries(
        Object.entries(buttonParams).map(([k, v]) => [Number(k), v.trim()]),
      );
    }
    onSelect(selected, values);
    handleOpenChange(false);
  }

  const previewBody = useMemo(() => {
    if (!selected) return "";
    const body =
      slots?.parameterFormat === "NAMED" ? namedParams : positionalParams;
    return renderTemplateBodyText(selected, { body });
  }, [selected, slots, namedParams, positionalParams]);

  const canConfirm =
    !!selected &&
    !!slots &&
    (slots.parameterFormat === "NAMED"
      ? slots.bodyNamed.every(
          (s) => (namedParams[s.name] ?? "").trim().length > 0,
        )
      : slots.bodyPositional.every(
          (_, i) => (positionalParams[i] ?? "").trim().length > 0,
        )) &&
    (slots.headerKind === "none" || headerText.trim().length > 0) &&
    slots.urlButtonSlots.every(
      (s) => (buttonParams[s.index] ?? "").trim().length > 0,
    );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <LayoutTemplate className="h-4 w-4 text-primary" />
            {selected ? selected.name : t("sendTemplate")}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {selected
              ? t("fillPlaceholders")
              : t("pickTemplate")}
          </DialogDescription>
        </DialogHeader>

        {!selected ? (
          <div className="max-h-[60vh] space-y-2 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              </div>
            ) : templates.length === 0 ? (
              <div className="rounded-md border border-border bg-background/50 p-6 text-center">
                <p className="text-sm text-popover-foreground">{t("noApprovedTemplates")}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("noApprovedTemplatesHint")}
                </p>
              </div>
            ) : (
              templates.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => pickTemplate(tpl)}
                  className="w-full rounded-md border border-border bg-background/50 p-3 text-left transition-colors hover:border-primary/40 hover:bg-popover"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium text-popover-foreground">
                          {tpl.name}
                        </p>
                        <Badge className="border border-primary/30 bg-primary/20 text-[10px] text-primary">
                          {tpl.category}
                        </Badge>
                        {tpl.language && (
                          <span className="text-[10px] uppercase text-muted-foreground">
                            {tpl.language}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {tpl.body_text}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  </div>
                </button>
              ))
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-background/50 p-3">
              <p className="mb-1 text-xs text-muted-foreground">{t("preview")}</p>
              <p className="whitespace-pre-wrap text-sm text-popover-foreground">
                {previewBody}
              </p>
              {selected.footer_text && (
                <p className="mt-2 text-xs italic text-muted-foreground">
                  {selected.footer_text}
                </p>
              )}
            </div>
            {slots?.headerKind !== "none" && (
              <div className="space-y-1">
                <Label className="text-xs text-popover-foreground">
                  {slots?.headerKind === "named"
                    ? slots.headerNamedVar
                    : `Header {{1}}`}
                </Label>
                <Input
                  value={headerText}
                  onChange={(e) => setHeaderText(e.target.value)}
                  placeholder={t("headerValuePlaceholder")}
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
              </div>
            )}
            {slots?.parameterFormat === "POSITIONAL"
              ? slots.bodyPositional.map((v, i) => (
                  <div key={v} className="space-y-1">
                    <Label className="text-xs text-popover-foreground">{`Body {{${v}}}`}</Label>
                    <Input
                      value={positionalParams[i] ?? ""}
                      onChange={(e) => {
                        const next = [...positionalParams];
                        next[i] = e.target.value;
                        setPositionalParams(next);
                      }}
                      placeholder={t("bodyValuePlaceholder", { val: `{{${v}}}` })}
                      className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                    />
                  </div>
                ))
              : slots?.bodyNamed.map((slot) => (
                  <div key={slot.name} className="space-y-1">
                    <Label className="text-xs text-popover-foreground">
                      {slot.name}
                    </Label>
                    <Input
                      value={namedParams[slot.name] ?? ""}
                      onChange={(e) =>
                        setNamedParams((prev) => ({
                          ...prev,
                          [slot.name]: e.target.value,
                        }))
                      }
                      placeholder={
                        slot.placeholder ||
                        t("bodyValuePlaceholder", { val: slot.name })
                      }
                      className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                    />
                  </div>
                ))}
            {slots?.urlButtonSlots.map((slot) => (
              <div key={slot.index} className="space-y-1">
                <Label className="text-xs text-popover-foreground">
                  {`${t("buttonLinkValueLabel")} — "${slot.text}"`}
                </Label>
                <Input
                  value={buttonParams[slot.index] ?? ""}
                  onChange={(e) =>
                    setButtonParams((prev) => ({
                      ...prev,
                      [slot.index]: e.target.value,
                    }))
                  }
                  placeholder={t("urlSuffixValuePlaceholder")}
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
                <p className="text-[10px] text-muted-foreground break-all">
                  {t("finalUrl", { url: slot.url.replace(/\{\{1\}\}/g, buttonParams[slot.index] || "{{1}}") })}
                </p>
              </div>
            ))}
          </div>
        )}

        <DialogFooter className="gap-2">
          {selected ? (
            <>
              <Button
                variant="outline"
                onClick={resetSelection}
                className="border-border text-popover-foreground hover:bg-muted"
              >
                <ArrowLeft className="h-4 w-4" />
                {t("back")}
              </Button>
              <Button
                disabled={!canConfirm}
                onClick={confirm}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {t("send")}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              onClick={() => handleOpenChange(false)}
              className="border-border text-popover-foreground hover:bg-muted"
            >
              {t("cancel")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
