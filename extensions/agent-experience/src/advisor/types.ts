export type AdvisorSeverity = 'concern' | 'blocker';
export type AdvisorAttempt = { kind: 'habit_violation'; habitAlias: string; severity: AdvisorSeverity };

export interface AdvisorScope {
  userId: string;
  sessionId: string;
  sessionFile: string;
}

export interface AdvisorPrimaryDelta {
  scope: AdvisorScope;
  epoch: number;
  generation: number;
  cursor: number;
  currentUserEntryId: string;
  primaryEntryIds: string[];
  causalEpisodeId: string;
  causedByAdvisor: boolean;
  text: string;
  observationText?: string;
  currentRequest: string;
  inProgress: boolean;
  toolEventCount: number;
  eventFingerprint: string;
}

export type AdvisorDiagnosticReason =
  | 'advisor_auth_unavailable'
  | 'advisor_cancelled'
  | 'advisor_context_overflow'
  | 'advisor_invalid_output'
  | 'advisor_observation_write_failed'
  | 'advisor_queue_coalesced'
  | 'advisor_timeout'
  | 'advisor_tool_budget_exhausted'
  | 'advisor_unavailable';

export interface AdvisorHabitCandidate {
  alias: string;
  habitId: string;
  condition: string;
  behavior: string;
  checksum: string;
  lawHash: string;
}

export interface AdvisorUpdate {
  schemaVersion: 1;
  scope: AdvisorScope;
  generation: number;
  epoch: number;
  cursor: number;
  inProgress: boolean;
  primaryDelta: string;
  observationText?: string;
  currentRequest: string;
  configuredLaw: string;
  habits: AdvisorHabitCandidate[];
  eventFingerprint: string;
  causalEpisodeId: string;
  causedByAdvisor: boolean;
}

export interface AcceptedAdvisorFinding {
  kind: 'habit_violation';
  candidate: AdvisorHabitCandidate;
  severity: AdvisorSeverity;
  eventFingerprint: string;
}

export interface AdvisorRuntimeConfig {
  enabled: boolean;
  model: string;
  timeoutMs: number;
  syncBacklog: 'off' | 1 | 3 | 5;
  immuneTurns: number;
}
