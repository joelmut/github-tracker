type Primitive =
  | String
  | Number
  | Function
  | Boolean
  | Symbol
  | null
  | undefined;

type Recursive<State> = {
  [K in keyof State]: (State[K] extends Primitive
    ? State[K]
    : State[K] extends (infer E)[]
    ? PropertyStore<E, State[K]>
    : PropertyStore<State[K]>) &
    Recursive<State[K]>;
};

type InferPathValue<State, P extends Path<State>> = InferArray<
  PathValue<State, P>
> extends Primitive
  ? PathValue<State, P>
  : PropertyStore<InferArray<PathValue<State, P>>, PathValue<State, P>>;

type InferArray<T> = T extends (infer E)[] ? E : T;

type Path<T> = PathImpl<InferArray<T>, keyof InferArray<T>> | keyof T;

type PathImpl<T, K extends keyof T> = K extends keyof T
  ? K extends string
    ? T[K] extends Record<string, any>
      ? T[K] extends (infer E)[]
        ?
            | K
            | `${K}.[].${PathImpl<E, keyof E>}`
            | `${K}.[${number}].${PathImpl<E, keyof E>}`
            | `${K}.[${number}]`
        : K | `${K}.${PathImpl<T[K], keyof T[K]>}`
      : K
    : never
  : T extends (infer E2)[]
  ? PathImpl<E2, keyof E2>
  : never;

type PathValue<T, P extends Path<T>> = P extends `${infer K}.${infer Rest}`
  ? K extends keyof T
    ? Rest extends Path<T[K]>
      ? PathValue<T[K], Rest>
      : Rest extends `${infer K2}.${infer Rest2}`
      ? T[K] extends (infer E)[]
        ? Rest2 extends Path<E>
          ? PathValue<E, Rest2>
          : never
        : never
      : T[K] extends (infer E)[]
      ? E
      : never
    : never
  : P extends keyof T
  ? T[P]
  : never;

export class Store<State> {
  state: PropertyStore<State> & Recursive<State>;
  constructor(state?: State) {
    this.state = Object.assign(state as any, new PropertyStore(state));
  }
}

class PropertyStore<State, OriginalState = State> {
  get size(): number {
    return 0;
  }

  get path(): string {
    return "";
  }

  constructor(private state: State) {}

  get<P extends Path<State>>(
    path: P
  ): PathValue<State, P> & InferPathValue<State, P> {
    return;
  }

  set(value: OriginalState): OriginalState;
  set<P extends Path<State>>(
    path: P,
    value: PathValue<State, P>
  ): PathValue<State, P> & InferPathValue<State, P>;
  set<P extends Path<State>>(
    pathOrValue: OriginalState | P,
    value?: PathValue<State, P>
  ): OriginalState | (PathValue<State, P> & InferPathValue<State, P>) {
    return;
  }

  reset(): State {
    return;
  }

  has<P extends Path<State>>(path: P): boolean {
    return;
  }

  delete(): boolean;
  delete<P extends Path<State>>(path: P): boolean;
  delete<P extends Path<State>>(path?: P): boolean {
    return;
  }

  subscribe<P extends Path<State>>(
    path: P,
    callback: (
      newValue: PathValue<State, P> & InferPathValue<State, P>,
      oldValue: PathValue<State, P> & InferPathValue<State, P>
    ) => void
  ): Function;
  subscribe<P extends Path<State>>(
    callback: (newValue: State, oldValue: State) => void
  ): Function;
  subscribe<P extends Path<State>>(
    pathOrCallback: P | ((newValue: State, oldValue: State) => void),
    callback?: (
      newValue: PathValue<State, P> & InferPathValue<State, P>,
      oldValue: PathValue<State, P> & InferPathValue<State, P>
    ) => void
  ): Function {
    return;
  }
}

// Tests

// interface Contributors {
//   name: string;
//   age: number;
//   role: {
//     name: "A" | "B";
//   };
// }

// interface Project {
//   name: string;
//   contributors: Contributors[];
// }

// interface State {
//   firstName: string;
//   lastName: string;
//   age: {
//     number: number;
//     test(): string;
//   };
//   projects: Project[];
// }

// const object = {
//   firstName: "Diego",
//   lastName: "Haz",
//   age: {
//     number: 30,
//   },
//   projects: [
//     { name: "Reakit", contributors: {} },
//     { name: "Constate", contributors: {} },
//   ],
// } as State;

// const store = new Store<State>(object);
// store.state.projects.map((e) => e.name);

// store.state.get("projects").get("at");
// store.state.get("projects").get("contributors");
// store.state.get("projects").get("contributors.[].role.name").get("at");

// store.state.age.get("number").get();
// store.state.projects.get("at");
// store.state.projects[0].get("contributors").get("role.name").get();
// store.state.projects.get("contributors");
// store.state.projects.get("contributors.[].role.name").get("at");

// store.state.age.number.get("at");
// store.state.age.test.get("at");
// store.state.projects[0].name.get("at");

// store.state.projects[0].set("name", true);
// store.state.projects[0].set({ name: "", age: 0, role: { name: "A" } });
// store.state.projects[0].set({ name: "", contributors: [] });
// store.state.projects[0].set("contributors.[].age", 1);
// store.state.set({ firstName: 3 });
// store.state.subscribe((newValue, oldValue) => {
//   newValue.age;
// });
// store.state.subscribe("projects", (newValue, oldValue) => {
//   newValue[0].name;
// });

// store.state.size;
// store.state.projects.size;
// store.state.age.size;
// store.state.firstName.size;
