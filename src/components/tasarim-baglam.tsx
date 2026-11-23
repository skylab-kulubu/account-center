"use client";

import { createContext, useContext } from "react";
import type { Tasarim } from "@/lib/tasarim";

// GEÇİCİ: istemci bileşenleri hangi tasarım yönünün açık olduğunu buradan okur.
const TasarimBaglam = createContext<Tasarim>("eski");

export function TasarimSaglayici({ value, children }: { value: Tasarim; children: React.ReactNode }) {
  return <TasarimBaglam.Provider value={value}>{children}</TasarimBaglam.Provider>;
}

export function useTasarim(): Tasarim {
  return useContext(TasarimBaglam);
}
