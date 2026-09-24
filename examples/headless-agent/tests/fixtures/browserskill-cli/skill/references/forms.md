# Documented bsk command forms

These are the documented bsk command forms the browser-skill skill teaches:

    bsk --help
    bsk session start --no-focus --json
    bsk navigate URL --session SESSION_ID
    bsk observe --session SESSION_ID
    bsk session stop SESSION_ID

`session stop` takes the session id as a positional argument. Every other
argument shape exits with code 2 and prints a diagnostic on stderr.
