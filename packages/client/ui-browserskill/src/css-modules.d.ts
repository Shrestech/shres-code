/** CSS Modules are typed as opaque class-record objects by the shared client build. */
declare module '*.module.css' {
  const classes: { readonly [key: string]: string }
  export default classes
}
