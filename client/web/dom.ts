// The pages' element lookup: an element is found by its id and must be of the class the
// page draws it as, so a page that lost or changed an element fails naming it.

export function elementById<T extends HTMLElement>(id: string, kind: { new (): T; prototype: T }): T {
  const element = document.getElementById(id);
  if (!(element instanceof kind)) throw new Error(`#${id} is missing or is not a ${kind.name}`);
  return element;
}
