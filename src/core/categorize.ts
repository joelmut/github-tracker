import R from "ramda";
import { equalFields } from "./utils";

interface CategorizeContext<T> {
  create: T[];
  update: T[];
  unknown: T[];
}

export function categorize<T>(
  base: T[],
  comparison: T[]
): CategorizeContext<T> {
  const id = ["repository", "number"] as (keyof T)[];
  const fields = [
    ...id,
    "state",
    "title",
    "labels",
    "assignees",
  ] as (keyof T)[];

  const unknown = comparison.filter(R.pipe(equalFields(base, id), R.not));
  const create = base.filter(R.pipe(equalFields(comparison, id), R.not));
  const update = base
    .filter(equalFields(comparison, id))
    .filter(R.pipe(equalFields(comparison, fields), R.not));

  return {
    create,
    update,
    unknown,
  };
}
