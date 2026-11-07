// The workstation page is a legacy URL that now lands on the React shell.
//
// This lives in its own file rather than inline in workstation.html because the
// query-key census reads scripts by src: an inline <script> is invisible to it,
// which is exactly the blind spot it exists to rule out. A 36-character
// redirect is not worth the hole in the coverage.
location.replace('/app/index.html');