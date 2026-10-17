export const $ = <T extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document,
) => {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
};

export const $$ = <T extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document,
) => Array.from(root.querySelectorAll<T>(selector));
