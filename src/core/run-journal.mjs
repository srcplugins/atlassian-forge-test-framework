// Durable intent-before-write lifecycle. Adapters implement resource-specific ownership checks.
import { randomUUID } from 'node:crypto';
export class FixtureRun {
  constructor({ state, save, adapters }) {
    this.state = state;
    this.save = save;
    this.adapters = adapters;
  }
  static create({ app, site, projectId, save, adapters, runId = randomUUID() }) {
    const state = {
      schemaVersion: 1,
      runId,
      app,
      site,
      projectId,
      started: new Date().toISOString(),
      status: 'active',
      resources: [],
      checks: [],
    };
    const run = new FixtureRun({ state, save, adapters });
    run.persist();
    return run;
  }
  persist() {
    this.save(structuredClone(this.state));
  }
  async create(kind, expected) {
    const started = Date.now();
    const entry = { kind, expected: structuredClone(expected), status: 'creating', id: null };
    this.state.resources.push(entry);
    this.persist();
    // A thrown POST leaves its intent available for reconciliation; never repeat it.
    let value;
    try {
      value = await this.adapters[kind].create(entry.expected);
    } catch (error) {
      if (error.definitiveRejection) {
        entry.status = 'rejected';
        this.persist();
      }
      throw error;
    }
    if (!/^[1-9][0-9]*$/.test(String(value?.id))) throw Error('Invalid created resource ID');
    entry.id = String(value.id);
    entry.status = 'created';
    this.persist();
    await this.adapters[kind].verify(entry);
    entry.prepareMs = Date.now() - started;
    this.persist();
    return entry;
  }
  check(name, value = true) {
    this.state.checks.push({ name, value });
    this.persist();
  }
  async cleanup({ concurrency = 1 } = {}) {
    if (
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 4 ||
      (concurrency > 1 && this.state.resources.some((entry) => entry.kind !== 'issue'))
    )
      throw Error('Concurrent cleanup is limited to four independent issue fixtures');
    const started = Date.now();
    this.state.status = 'cleaning';
    this.persist();
    const failures = [];
    const cleanEntry = async (entry) => {
      if (entry.status === 'removed') return;
      if (entry.status === 'rejected') {
        entry.status = 'removed';
        this.persist();
        return;
      }
      try {
        const adapter = this.adapters[entry.kind];
        if (!adapter) throw Error('Unknown resource kind');
        if (!entry.id) {
          const matches = await adapter.find(entry.expected);
          if (matches.length !== 1) throw Error('Ambiguous create; inspect before retry');
          entry.id = String(matches[0].id);
          entry.status = 'created';
          // Found by its unique marker after a lost create response: the adapter's verify knows
          // it has no baseline from creation time.
          entry.reconciled = true;
          this.persist();
        }
        entry.cleanupPhase = 'read';
        this.persist();
        const current = await adapter.read(entry.id);
        if (current === null) {
          if (entry.status !== 'deleting') throw Error('Resource unexpectedly absent');
          entry.status = 'removed';
          this.persist();
          return;
        }
        entry.cleanupPhase = 'verify';
        this.persist();
        await adapter.verify(entry, current);
        entry.status = 'deleting';
        this.persist();
        entry.cleanupPhase = 'delete';
        this.persist();
        await adapter.remove(entry);
        entry.cleanupPhase = 'confirm';
        this.persist();
        if ((await adapter.read(entry.id)) !== null)
          throw Error('Deletion not independently confirmed');
        entry.status = 'removed';
        this.persist();
      } catch (error) {
        // Harness errors carry no credentials or response bodies, so the reason can be kept.
        failures.push({
          kind: entry.kind,
          id: entry.id,
          status: entry.status,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    };
    const entries = [...this.state.resources].reverse();
    let next = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < entries.length) await cleanEntry(entries[next++]);
      }),
    );
    this.state.cleanupMs = Date.now() - started;
    this.state.leftovers = failures;
    this.state.status = failures.length ? 'cleanup-required' : 'clean';
    this.state.finished = new Date().toISOString();
    this.persist();
    if (failures.length)
      throw Error(
        `Fixture cleanup incomplete for run ${this.state.runId}; inspect its private journal.`,
      );
  }
}
