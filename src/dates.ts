/**
 * Server-side entry point for the zero-dependency fuzzy date/time parser.
 * The implementation lives in public/dates.js (a plain script, also loaded by
 * the browser via <script>); this module re-exports it for bun so tests and
 * server code share the exact same logic.
 */
// @ts-expect-error - plain JS module without type declarations
import RelayDates from "../public/dates.js";

export const parseDateTime: (text: string, nowMs?: number) => {
  start: string; end: string; matchedText: string; timeExplicit: boolean;
} | null = RelayDates.parseDateTime;

export const detectMeetingRequest: (text: string, nowMs?: number) => {
  start: string; end: string; matchedText: string; cue: string;
} | null = RelayDates.detectMeetingRequest;

export const detectAffirmation: (text: string) => string | null = RelayDates.detectAffirmation;
