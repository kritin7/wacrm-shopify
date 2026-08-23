/**
 * Build the Meta `components` array used by POST /{phone_number_id}/messages
 * when sending an APPROVED template.
 *
 * Distinct from `template-components.ts` — that module builds the
 * `components` for TEMPLATE CREATION (where you describe headers,
 * footers, buttons, examples). This module builds the per-send
 * `components` (where you fill in variable values and supply the
 * actual media link or button URL suffix for THIS specific delivery).
 *
 * Auto-fills as much as possible from the template row so callers
 * only need to supply values for the variable-bearing fields:
 *
 *   - Static IMAGE/VIDEO/DOCUMENT headers ride along automatically
 *     using the template's `header_media_url` (or `header_handle`).
 *     Meta requires the media component on every send even though
 *     the URL hasn't changed since approval.
 *   - TEXT headers with a variable need `headerText` from the caller.
 *   - Body variables come in as `body`, either `string[]` indexed by
 *     {{N}} (POSITIONAL templates) or `Record<string, string>` keyed
 *     by name (NAMED templates) — see `template.parameter_format`.
 *   - URL buttons with `{{1}}` need `buttonUrlParams[i]` keyed by
 *     button index. URL buttons without variables, plus QUICK_REPLY
 *     and PHONE_NUMBER buttons, don't need send-time parameters.
 *   - COPY_CODE buttons need the actual code to display. We fall
 *     back to the template's `example` value if the caller doesn't
 *     override — that matches the most common use case (a static
 *     promo code) without forcing UI work.
 *
 * Validation throws here (not at the Meta API boundary) so a missing
 * sample surfaces as "Header text variable {{1}} requires a value",
 * not a 400 from Meta that doesn't say which field broke.
 */

import type { MessageTemplate, TemplateButton } from '@/types';
import { extractVariableIndices, extractNamedVariables } from './template-validators';

export interface SendTimeParams {
  /**
   * Body variable values.
   *
   * POSITIONAL templates ({{1}}, {{2}}, …) — pass `string[]`, indexed
   * by variable position.
   *
   * NAMED templates ({{first_name}}, {{order_number}}, …) — pass
   * `Record<string, string>` keyed by the variable's name, e.g.
   * `{ first_name: "Rohit", order_number: "#8733" }`. Which shape a
   * template expects is `template.parameter_format` — passing the
   * wrong shape throws rather than silently sending the wrong values.
   */
  body?: string[] | Record<string, string>;
  /** Value for TEXT-header {{1}} (or {{name}} for NAMED), when the header has a variable. */
  headerText?: string;
  /** Override the template's static media URL for this send. */
  headerMediaUrl?: string;
  /** Alternative: send the media by Meta media id (from prior upload). */
  headerMediaId?: string;
  /**
   * Per-button overrides keyed by the button's index in the
   * template's `buttons` array. Used for URL buttons with a {{1}}
   * suffix and for COPY_CODE buttons whose example you want to
   * override at send time.
   */
  buttonParams?: Record<number, string>;
}

export type MetaSendComponent =
  | { type: 'header'; parameters: MetaSendParameter[] }
  | { type: 'body'; parameters: MetaSendParameter[] }
  | {
      type: 'button';
      sub_type: 'url' | 'quick_reply' | 'copy_code';
      index: string;
      parameters: MetaSendParameter[];
    };

type MetaSendParameter =
  | { type: 'text'; text: string; parameter_name?: string }
  | { type: 'image'; image: { link?: string; id?: string } }
  | { type: 'video'; video: { link?: string; id?: string } }
  | { type: 'document'; document: { link?: string; id?: string } }
  | { type: 'coupon_code'; coupon_code: string }
  | { type: 'payload'; payload: string };

function buildHeaderComponent(
  template: MessageTemplate,
  params: SendTimeParams,
): MetaSendComponent | null {
  const headerType = template.header_type;
  if (!headerType) return null;

  if (headerType === 'text') {
    // TEXT header with a variable → need a value. Static text headers
    // (no variables) just ride along inside the template itself; no
    // header component required on send — true for both parameter
    // formats since "has a variable" is what gates this, not the format.
    const headerContent = template.header_content ?? '';
    const isNamed = template.parameter_format === 'NAMED';
    const namedVars = isNamed ? extractNamedVariables(headerContent) : [];
    const varCount = isNamed
      ? namedVars.length
      : extractVariableIndices(headerContent).length;
    if (varCount === 0) return null;
    const value = params.headerText;
    if (!value || !value.trim()) {
      const placeholder = isNamed ? `{{${namedVars[0]}}}` : '{{1}}';
      throw new Error(
        `Header text variable ${placeholder} requires a value — pass headerText.`,
      );
    }
    const textParam: MetaSendParameter = isNamed
      ? { type: 'text', text: value, parameter_name: namedVars[0] }
      : { type: 'text', text: value };
    return {
      type: 'header',
      parameters: [textParam],
    };
  }

  // image / video / document — Meta requires the media component on
  // every send. Prefer the caller's explicit override; fall back to the
  // template's stored public URL.
  //
  // NOTE: `template.header_handle` is intentionally NOT used here. It's a
  // Resumable-Upload handle that's only valid as the *creation-time*
  // sample (`example.header_handle`); it is NOT a reusable send-time
  // media id, and passing it as `{ id }` makes Meta reject the send. Only
  // an explicit `headerMediaId` (a real /media upload id) is honored.
  const link = params.headerMediaUrl ?? template.header_media_url;
  const id = params.headerMediaId;
  if (!link && !id) {
    throw new Error(
      `${headerType} header requires a media link or id at send time — set header_media_url on the template or pass headerMediaUrl/headerMediaId.`,
    );
  }
  const mediaPayload: { link?: string; id?: string } = id ? { id } : { link };
  return {
    type: 'header',
    parameters: [
      headerType === 'image'
        ? { type: 'image', image: mediaPayload }
        : headerType === 'video'
          ? { type: 'video', video: mediaPayload }
          : { type: 'document', document: mediaPayload },
    ],
  };
}

function buildBodyComponent(
  template: MessageTemplate,
  params: SendTimeParams,
): MetaSendComponent | null {
  return template.parameter_format === 'NAMED'
    ? buildNamedBodyComponent(template, params)
    : buildPositionalBodyComponent(template, params);
}

function buildPositionalBodyComponent(
  template: MessageTemplate,
  params: SendTimeParams,
): MetaSendComponent | null {
  const varCount = extractVariableIndices(template.body_text).length;
  const body = params.body;
  if (body !== undefined && !Array.isArray(body)) {
    throw new Error(
      `Template "${template.name}" uses POSITIONAL parameters — pass body as a string[], not an object.`,
    );
  }
  const values = body ?? [];
  if (varCount === 0 && values.length === 0) return null;
  if (values.length < varCount) {
    throw new Error(
      `Body has ${varCount} variable(s) but only ${values.length} value(s) were supplied.`,
    );
  }
  // Trim to the variable count — extra values are dropped silently so
  // a legacy caller that passes too many doesn't error out.
  const trimmed = values.slice(0, varCount);
  return {
    type: 'body',
    parameters: trimmed.map((text) => ({ type: 'text', text: String(text) })),
  };
}

function buildNamedBodyComponent(
  template: MessageTemplate,
  params: SendTimeParams,
): MetaSendComponent | null {
  const names = extractNamedVariables(template.body_text);
  const body = params.body;
  if (names.length === 0) return null;
  if (Array.isArray(body)) {
    throw new Error(
      `Template "${template.name}" uses NAMED parameters — pass body as ` +
        `{ ${names.join(', ')} }, not an array.`,
    );
  }
  const values = body ?? {};
  const missing = names.filter((name) => !values[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Body is missing value(s) for named parameter(s): ${missing
        .map((n) => `{{${n}}}`)
        .join(', ')}.`,
    );
  }
  return {
    type: 'body',
    parameters: names.map((name) => ({
      type: 'text',
      parameter_name: name,
      text: String(values[name]),
    })),
  };
}

function buttonNeedsSendParam(
  button: TemplateButton,
  override: string | undefined,
): boolean {
  switch (button.type) {
    case 'URL':
      // URL button dynamic suffixes are always positional ({{1}}) per
      // Meta's spec — even on a NAMED-format template (e.g.
      // abandoned_cart: NAMED body, but its URL button dynamic suffix
      // is still {{1}}). Checked against the button's own `url`
      // string, independent of `template.parameter_format`.
      return extractVariableIndices(button.url).length > 0;
    case 'COPY_CODE':
      // We always emit a button param for COPY_CODE so the customer
      // gets a real code (either the caller's override or the
      // template's example as a default).
      return true;
    case 'QUICK_REPLY':
    case 'PHONE_NUMBER':
      return override !== undefined;
  }
}

function buildButtonComponent(
  button: TemplateButton,
  index: number,
  override: string | undefined,
): MetaSendComponent | null {
  if (!buttonNeedsSendParam(button, override)) return null;

  switch (button.type) {
    case 'URL': {
      // Each URL button is its own component with sub_type=url and
      // the button's index in the template's buttons array.
      if (!override || !override.trim()) {
        throw new Error(
          `URL button #${index + 1} uses {{1}} — requires a buttonParams[${index}] value.`,
        );
      }
      return {
        type: 'button',
        sub_type: 'url',
        index: String(index),
        parameters: [{ type: 'text', text: override }],
      };
    }
    case 'COPY_CODE': {
      const code = override?.trim() || button.example;
      return {
        type: 'button',
        sub_type: 'copy_code',
        index: String(index),
        parameters: [{ type: 'coupon_code', coupon_code: code }],
      };
    }
    case 'QUICK_REPLY': {
      // Only included when the caller explicitly overrides the
      // payload (rare — usually QR buttons use their default text).
      return {
        type: 'button',
        sub_type: 'quick_reply',
        index: String(index),
        parameters: [{ type: 'payload', payload: override! }],
      };
    }
    case 'PHONE_NUMBER':
      // PHONE_NUMBER buttons never accept send-time params per Meta —
      // return null even if an override snuck through.
      return null;
  }
}

/**
 * Build the full `components` array for the send-message payload.
 * Returns an empty array when the template is fully static (no
 * variables, no media header), which is a valid Meta request.
 */
export function buildSendComponents(
  template: MessageTemplate,
  params: SendTimeParams = {},
): MetaSendComponent[] {
  const out: MetaSendComponent[] = [];
  const header = buildHeaderComponent(template, params);
  if (header) out.push(header);
  const body = buildBodyComponent(template, params);
  if (body) out.push(body);
  if (template.buttons?.length) {
    template.buttons.forEach((btn, i) => {
      const override = params.buttonParams?.[i];
      const component = buildButtonComponent(btn, i, override);
      if (component) out.push(component);
    });
  }
  return out;
}
