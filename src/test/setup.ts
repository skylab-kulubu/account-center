import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// GEÇİCİ tasarım anahtarı: testler bugünkü görünümü ("eski") sınar; çerez okunmaz.
vi.mock("@/server/tasarim", () => ({ currentTasarim: async () => "eski" }));
