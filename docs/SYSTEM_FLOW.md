# System Flow — Evaluation and Enforced Protocol

**Verdict: the current system has the right data but the wrong rules.** Every
entity can be created in any order, and tracking works with none of them. This
document defines the protocol the system must enforce, and lists exactly where
it currently fails.

---

## 1. The flaw

A phone can enrol, go on duty, and appear on the live map **with no vehicle,
no driver, no customer and no consignment attached to it.**

That is what you saw: a dot moving on the map that represents nothing. It has
no registration number, so a dispatcher cannot act on it; no driver, so nobody
can be called; no consignment, so no customer is waiting on it.

The root cause is that `devices` was designed as a first-class entity. It is
not one. **A phone is an accessory to a vehicle.** It has no meaning on its own,
and the schema should not permit one to exist on its own.

---

## 2. The correct protocol

Each stage has a precondition. Nothing later can happen until the earlier
stage is satisfied.

```
STAGE 0   EMPTY SYSTEM
          Only "Add vehicle" is available. Every other action is disabled
          with the reason shown.
             │
STAGE 1   VEHICLE                          precondition: none
          Registration, specs, documents.
          → RC, insurance, PUC and fitness required before the vehicle can
            ever be dispatched (recorded, warned about, not silently ignored).
             │
STAGE 2   VEHICLE'S PHONE                  precondition: a vehicle exists
          The enrolment code is generated FOR a vehicle. There is no such
          thing as a standalone device.
          → the phone inherits the vehicle's identity; the map shows
            "RJ14GA5623", never "some phone".
             │
STAGE 3   DRIVER                           precondition: none (parallel to 1)
          Licence, documents, emergency contact.
          → an expired or missing licence blocks assignment, not creation.
             │
STAGE 4   CUSTOMERS                        precondition: none (parallel)
          Consignor and consignee, each with at least one geocoded address.
          → an address without coordinates is rejected: the route and the
            customer's map are built from coordinates, not text.
             │
STAGE 5   CONSIGNMENT                      precondition: 2 customers with addresses
          LR number (auto, unique, never reused), goods, e-way bill, freight.
             │
STAGE 6   TRIP                              precondition: consignment + vehicle
                                                          + driver + schedule
          Route chosen from real options.
          → dispatch check runs against the TRAVEL DATE.
          → assignment is refused if the vehicle or driver is already
            committed to an overlapping trip.
             │
STAGE 7   TRACKING LINKS                    precondition: a trip exists
          One per party, issued automatically. Shared manually or sent.
             │
STAGE 8   DRIVER GOES ON DUTY               precondition: an assigned trip
                                                          starting today
          → THIS IS THE GATE THAT IS MISSING TODAY.
          → going on duty starts the trip; position now belongs to that trip.
             │
STAGE 9   IN TRANSIT
          Customers see the truck. Dispatch sees it against the planned route.
             │
STAGE 10  DELIVERED
          POD captured, trip closed, tracking links expire.
```

### The single rule that fixes the flaw

> **A position fix only exists in the context of a trip.**

A phone that is enrolled but has no active trip is not "a vehicle on the map".
It is a phone sitting in a parked truck, and the live map should say exactly
that — or not show it at all.

---

## 3. Where the current system violates this

| # | Violation | Consequence | Severity |
|---|---|---|---|
| 1 | `devices` has no `vehicle_id`. A device is created with a free-text label. | Phantom vehicles on the map. **This is what you saw.** | **Critical** |
| 2 | `POST /v1/devices` can be called with no vehicle in the system at all. | Stage 2 runs before stage 1. | **Critical** |
| 3 | `POST /v1/devices/me/duty` accepts `onDuty: true` with no trip assigned. | Tracking with no purpose; battery burned for nothing; a driver appears "working" when no job exists. | **Critical** |
| 4 | Ingest accepts fixes from any active device regardless of duty or trip. | Position data with no trip to attach it to. | High |
| 5 | `/v1/tracking/latest` returns devices, not trips. | The fleet map is a list of phones, not of jobs. | High |
| 6 | A trip can be booked with `vehicleId: null` and `driverId: null`. | A consignment with nothing carrying it, silently. | High |
| 7 | Nothing prevents assigning one vehicle or driver to two overlapping trips. | Double-booking. Discovered on the road. | High |
| 8 | Dispatch check is advisory only and its result is discarded after booking. | An expired-PUC vehicle can be dispatched with no record that anyone was warned. | Medium |
| 9 | The UI shows every nav item from the first second. | A new manager can open "Book consignment" on an empty system and hit dead ends. | Medium |
| 10 | Empty-state action buttons do not fire (known bug). | The one action a new user needs on day one does nothing. | Medium |

---

## 4. Required changes

### Schema

```
devices
  + vehicle_id  UUID NOT NULL  → vehicles.id
  − label       (derived from the vehicle's registration instead)

trips
  + UNIQUE-ish guard: no overlapping active trip per vehicle_id
  + UNIQUE-ish guard: no overlapping active trip per driver_id

location_pings
  + trip_id  UUID NULL → trips.id
      Nullable because a fix can legitimately arrive moments before the trip
      is marked started; but the ingest pipeline attaches it to the device's
      current active trip whenever one exists.
```

### API rules

| Endpoint | New precondition |
|---|---|
| `POST /v1/devices` | Requires `vehicleId`. 409 if that vehicle already has an active device. |
| `POST /v1/devices/me/duty {onDuty:true}` | **409 unless an assigned trip exists for this device starting within ±12 h.** Response names the trip. |
| `POST /v1/ingest/*` | Accepted only while on duty. Off-duty fixes are rejected with a clear reason rather than silently stored. |
| `POST /v1/bookings` | `vehicleId` and `driverId` become **required**. |
| `POST /v1/bookings` | 409 if vehicle or driver overlaps another active trip. |
| `POST /v1/bookings` | If the dispatch check is blocking, require an explicit `acknowledgeRisk: true` and record who acknowledged it. |
| `GET /v1/tracking/latest` | Returns **trips**, each with its vehicle, driver, consignment and position — not bare devices. |

### UI rules

- Nav items are **disabled with a reason** until their precondition is met:
  *"Add a vehicle first"*, *"Add two customers first"*.
- A setup checklist on the dashboard for an empty system, in order.
- The booking form cannot be submitted without vehicle and driver.
- The live map shows *trips*. A parked, enrolled phone appears in a separate
  "Idle vehicles" list, clearly not a job in progress.

### Mobile rules

- The duty toggle is **disabled** when no trip is assigned, and says so:
  *"No trip scheduled. Dispatch will assign one."*
- Going on duty shows which trip is starting.
- Enrolment is bound to a vehicle, so the app shows the registration number
  from the moment it is set up.

---

## 5. What this costs

| Change | Size |
|---|---|
| Schema: `devices.vehicle_id`, `pings.trip_id`, overlap guards | migration + model edits |
| Backend: preconditions on 6 endpoints, rewrite `/tracking/latest` | ~1 day |
| Web: setup checklist, disabled nav, trip-centric map, required fields | ~1 day |
| Mobile: gated duty toggle, vehicle identity, trip context | ~half day |
| Tests for every precondition | ~half day |

The data model barely changes — the entities were right. What is missing is
the **rules between them**, and that is what makes it a system rather than a
set of forms.

---

## 6. Deliberate exceptions

Not everything should be rigid, and pretending otherwise produces software
people work around:

- **Documents may expire while a trip is in flight.** Warn, do not cancel.
- **A driver may need to start early or late.** The ±12 h window is generous
  on purpose.
- **A vehicle may be swapped after a breakdown.** Reassignment is allowed on
  an in-flight trip; the LR number does not change, which is why consignment
  and trip are separate tables.
- **Dispatch may knowingly send a vehicle with a lapsed document.** Allowed,
  but only with an explicit acknowledgement that is recorded against a named
  user. The point is accountability, not obstruction.
