import type { ReactNode } from "react";

import { Link } from "react-router";

// The compact list pages share: one line per row, the whole row a link or a
// button when it has a destination. Callers pass their own trailing cells,
// with widths and phone/desktop visibility set by class, and the header above
// the rows carries the same classes, which keeps the columns lined up.
export function RowList(props: { header?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="row-list -mx-4 md:mx-0">
      {props.header}
      <ul>{props.children}</ul>
    </div>
  );
}

interface RowBaseProps {
  icon?: ReactNode;
  title: ReactNode;
  // Cells after the title, right-aligned in the order given.
  cells?: ReactNode;
  // Marks the row as the deep-linked target.
  highlighted?: boolean;
}

export type RowProps = RowBaseProps &
  ({ to: string; onClick?: never } | { onClick: () => void; to?: never } | { to?: never; onClick?: never });

const ROW = "flex h-10 w-full items-center gap-3 px-4 text-left text-sm hover:bg-muted/50 active:bg-muted/50 md:px-3";

export function Row(props: RowProps): ReactNode {
  const content = (
    <>
      {props.icon}
      <span className="min-w-0 flex-1 truncate">{props.title}</span>
      {props.cells}
    </>
  );
  const highlighted = props.highlighted ? true : undefined;

  if (props.to !== undefined) {
    return (
      <li data-highlight={highlighted}>
        <Link to={props.to} className={ROW}>
          {content}
        </Link>
      </li>
    );
  }

  if (props.onClick !== undefined) {
    return (
      <li data-highlight={highlighted}>
        <button type="button" onClick={props.onClick} className={ROW}>
          {content}
        </button>
      </li>
    );
  }

  // Rows with interactive cells (approve/deny buttons) stay inert themselves:
  // nesting a button inside a link or button is not valid HTML.
  return (
    <li className={ROW} data-highlight={highlighted}>
      {content}
    </li>
  );
}

// The column labels above the rows, laid out by the caller with the rows' own
// cell classes.
export function RowHeader(props: { children: ReactNode }): ReactNode {
  return <div className="flex h-8 items-center gap-3 px-4 text-xs text-muted-foreground md:px-3">{props.children}</div>;
}

// What a list says in place of its rows when it has none, with an optional
// next-step action below the copy.
export function EmptyRows(props: { children: ReactNode; action?: ReactNode }): ReactNode {
  return (
    <li className="px-4 py-6 text-sm text-muted-foreground md:px-3">
      <div className="flex flex-col items-start gap-3">
        <span>{props.children}</span>
        {props.action}
      </div>
    </li>
  );
}
