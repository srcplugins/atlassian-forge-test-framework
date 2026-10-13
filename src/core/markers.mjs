import { config } from './config.mjs';

// Every identifier the harness persists on owned sites to mark what it owns: project
// descriptions and names, issue labels, summaries and properties. Writes
// use only these values. Checks that decide ownership, verification or cleanup go through
// `isMarker` or `markerForms`, never a direct comparison. The namespace comes from the
// configuration; legacyNamespaces are recognized (never written) so fixtures created under an
// earlier name stay verifiable and removable.
const ns = () => config().namespace;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const markers = {
  get namespace() {
    return ns();
  },
  /** Issue property holding a property-marked fixture's run marker. */
  get fixtureProperty() {
    return `${ns()}.fixture`;
  },
  /** Disposable browser fixture projects. */
  browserProject: (app) => `${ns()} browser fixtures v1: ${app}. Synthetic data only.`,
  browserProjectName: (app) => `${ns()} E2E ${app}`,
  /** Per-resource run marker, used as an issue label or fixture property value. */
  runMarker: (runId, index) => `${ns()}-e2e-${runId}-${index}`,
  /**
   * A repository's own fixture marker, for resources the shared helpers don't create (for
   * example a project a runner makes): "<namespace> acceptance <name>: <detail>".
   */
  acceptance: (name, detail) => `${ns()} acceptance ${name}: ${detail}`,
  disposableIssue: (marker) => `${ns()} disposable fixture ${marker}`,
  /** The development project and its landing issue on each owned site. */
  get developmentProject() {
    return `${ns()} owned synthetic development fixtures. No customer data. fixture-v1`;
  },
  get developmentProjectName() {
    return `${ns()} Development`;
  },
  get setupIssueSummary() {
    return `${ns()} setup smoke fixture`;
  },
  get setupIssueLabel() {
    return `${ns()}-setup-fixture`;
  },
  /** The identity project and its isolated permission scheme for pinned identities. */
  get identityProject() {
    return `${ns()} owned identity permission fixtures v1. Synthetic data only.`;
  },
  /** Persistent demo projects (for example listing media). Only the description is marked. */
  listingProject: (slug) => `${ns()} listing demo v1: ${slug}. Synthetic data only.`,
  /** Issue property identifying a demo issue. */
  get listingProperty() {
    return `${ns()}.listing`;
  },
};

/**
 * A marker rewritten into one earlier namespace. Every marker starts with the namespace; only
 * that leading occurrence is rewritten, so an app slug or detail that happens to contain the
 * namespace stays as it was written. Before "." or "-" (property keys, labels) it becomes the
 * earlier slug, otherwise (prose) the earlier brand.
 */
function rewrite(marker, legacy) {
  const pattern = new RegExp(`^${escape(ns())}([.-]?)`);
  return marker.replace(pattern, (_, separator) =>
    separator ? `${legacy.slug}${separator}` : legacy.brand,
  );
}
/** The first configured earlier form of a marker (or the marker itself when none). */
export const legacyMarker = (marker) => {
  const [legacy] = config().legacyNamespaces;
  return legacy ? rewrite(marker, legacy) : marker;
};
/** Every accepted form of a marker, current first. */
export const markerForms = (marker) => [
  ...new Set([marker, ...config().legacyNamespaces.map((legacy) => rewrite(marker, legacy))]),
];
/** True when an observed value is the current marker or an earlier form. */
export const isMarker = (actual, marker) =>
  typeof actual === 'string' && markerForms(marker).includes(actual);
/** Run-marker prefixes, current first; a legacy namespace may name its own (runPrefix). */
const runPrefixes = () => [
  `${ns()}-e2e-`,
  ...config()
    .legacyNamespaces.filter((l) => l.runPrefix)
    .map((l) => `${l.runPrefix}-e2e-`),
];
/** True when a value is one of this run's resource markers, in the current or an earlier form. */
export const isRunMarker = (actual, runId) =>
  typeof actual === 'string' &&
  runPrefixes().some((prefix) => new RegExp(`^${escape(prefix + runId)}-\\d+$`).test(actual));
const kinds = 'E2E|disposable|owned|acceptance|setup smoke|browser fixtures|Development';
/** Patterns for any harness marker that could show on a page; published media must contain none. */
export const visibleMarkerPatterns = () => [
  ...runPrefixes(),
  ...[ns(), ...config().legacyNamespaces.map((l) => l.brand)].map((n) => `${escape(n)} (${kinds})`),
  'fixture-v1',
];
