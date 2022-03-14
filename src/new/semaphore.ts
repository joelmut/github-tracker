import { cpus } from "os";

interface Lock<Context> {
  release: (context?: Context) => void;
  context?: Context;
}

interface LockPromise<Context> {
  resolve: (lock: Lock<Context>) => void;
  reject: (err?: Error) => void;
}

interface Collection<Context> {
  size: number;
  items: Array<LockPromise<Context>>;
  context?: Context;
}

export class Semaphore<Context = any> {
  private collection: Record<string, Collection<Context>> = {};

  constructor(private size: number = cpus().length) {}

  async acquire(key?: string): Promise<Lock<Context>> {
    const id = key ?? "*";
    let collection = this.collection[id];

    if (!collection) {
      collection = this.collection[id] = { size: 0, items: [] };
    }

    if (collection.size < this.size) {
      collection.size++;
      return { release: this.release(id), context: collection.context };
    }

    return new Promise<Lock<Context>>((resolve, reject) => {
      collection.items.push({ resolve, reject });
    });
  }

  private release(id: string) {
    const collection = this.collection[id];
    return (context?: Context) => {
      collection.context = context;
      collection.size--;
      const promise = collection.items.shift();
      promise?.resolve({ release: this.release(id), context });
    };
  }
}
