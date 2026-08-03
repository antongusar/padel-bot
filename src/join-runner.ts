import {
  JoinCoordinatorClient,
  type BeginJoinResult,
  type JoinCoordinatorState,
} from "./join-coordinator";

export interface CoordinatedPerson {
  id: string;
}

export interface CoordinatedResult {
  id: string;
  ok: boolean;
  reason?: string;
}

export interface CoordinatedBatchOptions<
  TPerson extends CoordinatedPerson,
  TResult extends CoordinatedResult,
> {
  coordinator: JoinCoordinatorClient;
  people: TPerson[];
  maxAttempts: number;
  beforeBatch?: () => Promise<void>;
  joinPerson: (person: TPerson, heartbeat: () => Promise<void>) => Promise<TResult>;
  personError: (person: TPerson, error: unknown) => TResult;
  afterBatch?: () => Promise<void>;
}

export interface CoordinatedBatchResult<TResult extends CoordinatedResult> {
  status: BeginJoinResult["status"];
  acquired: boolean;
  completedNow: boolean;
  results: TResult[];
  state?: JoinCoordinatorState;
  begin: BeginJoinResult;
  error?: string;
}

export async function runCoordinatedBatch<
  TPerson extends CoordinatedPerson,
  TResult extends CoordinatedResult,
>(
  options: CoordinatedBatchOptions<TPerson, TResult>,
): Promise<CoordinatedBatchResult<TResult>> {
  const peopleById = new Map(options.people.map((person) => [person.id, person]));
  const personIds = options.people.map((person) => person.id);
  const begin = await options.coordinator.begin(personIds, options.maxAttempts);

  if (begin.status !== "acquired") {
    return {
      status: begin.status,
      acquired: false,
      completedNow: false,
      results: [],
      begin,
    };
  }

  const token = begin.token;
  const remaining = begin.remainingIds
    .map((id) => peopleById.get(id))
    .filter((person): person is TPerson => Boolean(person));
  const results: TResult[] = [];
  let fatalError: string | undefined;
  let state: JoinCoordinatorState | undefined;

  try {
    await options.beforeBatch?.();

    for (const person of remaining) {
      await options.coordinator.startPerson(token, person.id);

      let result: TResult;
      try {
        result = await options.joinPerson(person, () =>
          options.coordinator.heartbeat(token).then(() => undefined),
        );
      } catch (error) {
        result = options.personError(person, error);
      }
      results.push(result);

      if (result.ok) {
        // Persist before moving to the next person. A later failure cannot
        // erase this checkpoint because all writes go through the same object.
        // Coordinator errors are fatal: a stale owner must stop immediately.
        await options.coordinator.markJoined(token, person.id);
      }
    }
  } catch (error) {
    fatalError = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await options.afterBatch?.();
    } catch (error) {
      fatalError ||= error instanceof Error ? error.message : String(error);
    }

    try {
      state = await options.coordinator.finish(token, personIds, fatalError);
    } catch (error) {
      fatalError ||= error instanceof Error ? error.message : String(error);
    }
  }

  return {
    status: "acquired",
    acquired: true,
    completedNow: state?.done === true,
    results,
    state,
    begin,
    error: fatalError,
  };
}
