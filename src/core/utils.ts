import R from "ramda";

export const equalFields = <T>(list: T[], keys: (keyof T)[]) =>
  R.pipe(R.pick(keys), R.includes(R.__, R.map(R.pick(keys), list)));

export const move = <T1, T2>(
  from: T1[],
  to: T2[],
  condition?: (value?: T1, index?: number, array?: T1[]) => boolean
): [T1[], T2[]] => {
  if (!condition) {
    return [[], [...to, ...(from as any[])]];
  }

  const newTo = [...to];
  const newFrom = from.filter((e, i, array) => {
    if (!condition(e, i, array)) return true;
    newTo.push(e as any);
    return false;
  });

  return [newFrom, newTo];
};
