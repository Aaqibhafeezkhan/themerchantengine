import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseAnswers, type SetupAnswers } from './answers';
import type { SetupArgs } from './cli/args';
import {
  DocumentPrompter,
  InteractivePrompter,
  readlineReader,
  type LineReader,
  type Prompter,
} from './cli/prompter';
import { ui, type Output } from './cli/ui';
import type { Ports } from './ports';
import { installContext, runInstall } from './runner/install';
import { dryRunShell, realShell, type Shell } from './runner/shell';
import { STEPS, stepsFor } from './steps';
import type { Step, StepContext } from './steps/types';
import {
  emptyState,
  markCompleted,
  mergeAnswers,
  readState,
  writeState,
  type SetupState,
} from './state/state-file';
import { ENGINE_VERSION } from './version';

export interface RunDeps {
  out: Output;
  ports: Ports;
  /** Built lazily: only an interactive run opens stdin. */
  reader?: () => LineReader;
  steps?: readonly Step[];
  isTTY?: boolean;
  /** The shell the install runs on; the real one unless a spec injects another. */
  shell?: Shell;
}

/**
 * The step loop (plan E4.2). Loads the state file, answers from the document
 * when one was given, asks a person otherwise, runs every step the profile
 * needs, and persists after each one so a crash or a Ctrl-C resumes at the
 * step it stopped on.
 */
export async function runStepper(args: SetupArgs, deps: RunDeps): Promise<SetupState> {
  const { out, ports } = deps;
  const stateFile = path.resolve(args.root, args.stateFile);
  let state = args.reset ? emptyState() : readState(stateFile);

  let document: SetupAnswers | null = null;
  if (args.answersFile) {
    const file = path.resolve(args.root, args.answersFile);
    document = parseAnswers(JSON.parse(fs.readFileSync(file, 'utf8')), file, (message) =>
      ui.warn(out, message),
    );
  }
  if (args.profile) {
    state = mergeAnswers(state, { profile: args.profile });
    document = { ...(document ?? {}), profile: args.profile };
  }

  const interactive = deps.isTTY ?? Boolean(process.stdin.isTTY);
  let reader: LineReader | null = null;
  let prompter: Prompter;
  if (interactive) {
    reader = (deps.reader ?? readlineReader)();
    prompter = new InteractivePrompter(reader, out, document);
  } else {
    if (!document) {
      throw new Error(
        'stdin is not a terminal and no --answers document was given; nothing can answer the stepper',
      );
    }
    // The document is the whole answer set: an earlier run's answers would
    // fill whatever it leaves out.
    state = document.profile
      ? mergeAnswers(emptyState(), { profile: document.profile })
      : emptyState();
    prompter = new DocumentPrompter(document);
  }

  ui.banner(out, ENGINE_VERSION);
  try {
    const all = deps.steps ?? STEPS;
    const context: StepContext = {
      answers: state.answers,
      prompter,
      out,
      ports,
      root: args.root,
      dryRun: args.dryRun,
    };
    // The profile decides which later steps apply, so it always runs first
    // and the list is recomputed after it.
    const profileStep = all[0];
    // Known up front when --profile or a previous run answered it, so the
    // headers count the real total from the first step.
    let steps = state.answers.profile
      ? stepsFor(state.answers.profile).filter((s) => all.includes(s))
      : all.slice(0, 1);
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      const done = state.completedSteps.includes(step.id) && document === null;
      ui.step(
        out,
        i + 1,
        steps.length,
        done ? `${step.title} (done, Enter keeps each answer)` : step.title,
      );
      await step.run(context);
      state = markCompleted(mergeAnswers(state, context.answers), step.id);
      if (!args.dryRun) writeState(stateFile, state);
      if (step === profileStep) {
        steps = stepsFor(state.answers.profile).filter((s) => all.includes(s));
      }
    }
  } finally {
    reader?.close();
  }
  return state;
}

/** The whole run: the stepper, then the install of the profile it answered. */
export async function runSetup(args: SetupArgs, deps: RunDeps): Promise<void> {
  const state = await runStepper(args, deps);
  const base = realShell(deps.out);
  const shell = deps.shell ?? (args.dryRun ? dryRunShell(deps.out, base) : base);
  if (args.dryRun)
    ui.note(deps.out, 'dry run: every command and file below is printed, not executed');
  const ctx = installContext(state.answers, args.root, shell, deps.ports, deps.out);
  await runInstall(ctx);
}
