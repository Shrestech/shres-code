# Line format

The transformer consumes comma-delimited text lines:

- The first line is a header naming the columns; `transformLines` skips it.
- Every later line is a record; fields are separated by `,`.
- There is no quoting: fields never contain a comma, and double-quote
  characters are ordinary text.

`transformLines(lines)` returns one JSON array string per record line, in
input order.
