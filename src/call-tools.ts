/**
 * Which tenant tools a call gets, and how their requests are routed (T4c).
 *
 * Inbound calls (SIP / web LiveTest / unknown): exactly the historical rules
 * (calendar/crm unless the plan says false, orders when toggled, transfer on
 * PSTN). Requests route by the dialed number (`x-tenant-phone`), else by the
 * web user id (`x-tenant-user-id`).
 *
 * Outbound calls (campaign / outbound_test): the web turns tools on only when
 * its OUTBOUND_TOOLS switch and the agent's toggles allow it, and then sends
 * `accountId` (the campaign owner's user id). Outbound tools route ONLY by
 * that id — never by a call number: our caller id may be the trunk's default
 * number, which can belong to another account. No accountId → no calendar
 * tool (fail closed). Orders stay off on outbound. Transfer: campaign (a real
 * SIP leg) with a transfer number; never on outbound_test (a web room).
 *
 * Pure: unit-tested in tests/outbound-tools.test.ts.
 */
import type { AgentFeatures, SessionOrigin } from './types.js';

export interface CallToolPlan {
  /** Passed to makeCalendarTools as `features`. */
  calendarFeatures: { calendar: boolean; crm: boolean };
  /** Set on outbound calls with tools: route every tool request by this id. */
  outboundAccountId?: string;
  /** Register record_order. */
  orders: boolean;
  /** Register transfer_call. */
  transfer: boolean;
  /** A misconfiguration to report (the tools were withheld). */
  error?: { event: string; message: string };
}

export interface CallToolConfig {
  features: AgentFeatures;
  ordersEnabled?: boolean;
  accountId?: string;
  transferNumber?: string;
}

export function isOutboundOrigin(kind: SessionOrigin['kind']): boolean {
  return kind === 'campaign' || kind === 'outbound_test';
}

const nonEmpty = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';

export function planCallTools(origin: SessionOrigin, cfg: CallToolConfig): CallToolPlan {
  if (!isOutboundOrigin(origin.kind)) {
    // Inbound: unchanged.
    return {
      calendarFeatures: {
        calendar: cfg.features.calendar !== false,
        crm: cfg.features.crm !== false,
      },
      orders: cfg.ordersEnabled === true,
      transfer: origin.kind === 'sip' && origin.channel === 'pstn',
    };
  }

  // Outbound: opt-in only (an absent feature is OFF here, unlike inbound).
  const accountId = nonEmpty(cfg.accountId) ? cfg.accountId.trim() : '';
  const wantsCalendar = cfg.features.calendar === true;
  const wantsCrm = cfg.features.crm === true;
  const plan: CallToolPlan = {
    calendarFeatures: {
      calendar: wantsCalendar && accountId !== '',
      crm: wantsCrm && accountId !== '',
    },
    orders: false,
    transfer: origin.kind === 'campaign' && nonEmpty(cfg.transferNumber),
  };
  if (accountId) plan.outboundAccountId = accountId;
  if ((wantsCalendar || wantsCrm) && !accountId) {
    plan.error = {
      event: 'outbound_tools_no_account',
      message: 'Outbound booking requested without accountId: calendar tools withheld',
    };
  }
  return plan;
}

/** Tenant-routing headers for one tool request. */
export function tenantRoutingHeaders(ctx: {
  dialedPhone: string;
  getDialedPhone?: () => string;
  tenantUserId: string;
  outboundAccountId?: string;
}): Record<string, string> {
  if (ctx.outboundAccountId) {
    // Outbound: the account id only, never a call number.
    return { 'x-tenant-user-id': ctx.outboundAccountId, 'x-call-direction': 'outbound' };
  }
  // Inbound: prefer x-tenant-phone (SIP), else x-tenant-user-id (web
  // LiveTest). Dialed number read LIVE (late SIP attributes).
  const dialedPhone = ctx.getDialedPhone?.() || ctx.dialedPhone;
  const headers: Record<string, string> = {};
  if (dialedPhone) {
    headers['x-tenant-phone'] = dialedPhone;
  } else if (ctx.tenantUserId) {
    headers['x-tenant-user-id'] = ctx.tenantUserId;
  }
  return headers;
}
