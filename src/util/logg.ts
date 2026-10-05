const tid = () => new Date().toISOString().slice(11, 19);

export const logg = {
  info: (msg: string) => console.log(`${tid()}  ${msg}`),
  varning: (msg: string) => console.warn(`${tid()}  VARNING  ${msg}`),
  fel: (msg: string) => console.error(`${tid()}  FEL      ${msg}`),
  steg: (msg: string) => console.log(`${tid()}  -> ${msg}`),
};

export const paus = (ms: number) => new Promise((r) => setTimeout(r, ms));
