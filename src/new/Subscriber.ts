import mitt, { Emitter } from "mitt";

type PickArray<T, T2 extends T> = T2;

export interface IPayloadData<T, M, PT extends TPayloadDataTypes = "All"> {
  event: PickArray<T, Extract<T, keyof M>>;
  payload: PT extends "All"
    ?
        | (T extends string ? M[Extract<T, keyof M>] : never)
        | (T extends string ? M[Extract<T, keyof M>] : never)[]
    : PT extends "Single"
    ? T extends string
      ? M[Extract<T, keyof M>]
      : never
    : PT extends "Array"
    ? (T extends string ? M[Extract<T, keyof M>] : never)[]
    : never;
}

export interface ISubscribeOptions<
  E,
  Map,
  PT extends TPayloadDataTypes = "All"
> {
  events: E[];
  listen(
    payload: IPayloadData<PickArray<E, Extract<E, keyof Map>>, Map, PT>
  ): void;
}

export interface INotifyOptions<E, Map, PT extends TPayloadDataTypes = "All"> {
  events: E[];
  payload: IPayloadData<PickArray<E, Extract<E, keyof Map>>, Map, PT>;
}

export const PayloadDataTypes = ["All", "Array", "Single"] as const;
export type TPayloadDataTypes = typeof PayloadDataTypes[number];

export interface ISubscriber {
  subscribe(options): void;
  notify(options): void;
  notify(events, payload): void;
}

export class Subscriber<
  Events extends {},
  Map = any,
  PayloadType extends TPayloadDataTypes = "All"
> implements ISubscriber
{
  private EmitterClient: Emitter<Events>;
  private events: Set<string> = new Set();

  constructor() {
    this.EmitterClient = mitt<Events>();
  }

  subscribe<E extends Events = Events>(
    options: ISubscribeOptions<E, Map, PayloadType>
  ) {
    options.events.forEach((e: any) => {
      this.EmitterClient.on(e, options.listen);
      this.events.add(e);
    });
  }

  notify<E extends Events = Events>(
    options: INotifyOptions<E, Map, PayloadType>
  ): void;
  notify<E extends Events = Events>(
    events: E[],
    payload: IPayloadData<PickArray<E, Extract<E, keyof Map>>, Map, PayloadType>
  ): void;
  notify<E extends Events = Events>(
    events: E[] & INotifyOptions<E, Map, PayloadType>,
    payload?: IPayloadData<
      PickArray<E, Extract<E, keyof Map>>,
      Map,
      PayloadType
    >
  ): void {
    const ev = events?.events ?? events;
    const dt = events?.payload ?? payload;

    ev.forEach((e: any) =>
      this.EmitterClient.emit(e, { event: ev, payload: dt })
    );
  }
}
