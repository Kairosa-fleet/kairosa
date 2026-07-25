"use client";

/** Shared React Query hooks, so keys are never duplicated across pages. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./api";
import type { Device, Driver } from "./types";

export const keys = {
  me: ["me"] as const,
  devices: ["devices"] as const,
  drivers: ["drivers"] as const,
  positions: ["positions", "latest"] as const,
};

export function useDevices() {
  return useQuery<Device[]>({ queryKey: keys.devices, queryFn: api.listDevices });
}

/** Includes retired handsets — for the device administration screen only. */
export function useAllDevices() {
  return useQuery<Device[]>({
    queryKey: [...keys.devices, "all"],
    queryFn: api.listAllDevices,
  });
}

export function useDrivers() {
  return useQuery<Driver[]>({ queryKey: keys.drivers, queryFn: api.listDrivers });
}

export function useRegisterDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ label, driverId }: { label: string; driverId?: string | null }) =>
      api.registerDevice(label, driverId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.devices }),
  });
}

export function useRevokeDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.revokeDevice(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.devices }),
  });
}

export function useCreateDriver() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { fullName: string; phone?: string; employeeCode?: string }) =>
      api.createDriver(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.drivers }),
  });
}
