export type ReceiptDeclaration<T> = {
  readonly __receipt: true;
  readonly sample?: T;
};

export const receipt = <T>(): ReceiptDeclaration<T> => ({
  __receipt: true,
});

export type ReceiptBody<Decl> = Decl extends ReceiptDeclaration<infer T> ? T : never;
