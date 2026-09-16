const RATES = {
  CLT: { label: "Charlotte Douglas (CLT)", totalCents: 12000 },
  GSO: { label: "Greensboro / Piedmont Triad (GSO)", totalCents: 36000 },
  RDU: { label: "Raleigh-Durham (RDU)", totalCents: 58000 },
};

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function bookingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "LNL-";
  for (let i = 0; i < 4; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)] || "X";
  }
  return out;
}

function isPickupTooSoon(iso) {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return true;
  return at - Date.now() < 60 * 60 * 1000;
}

async function emailOwner(fields) {
  try {
    await fetch("https://formspree.io/f/xqenoyza", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(fields),
    });
  } catch {
    // Payment already succeeded — Square still has the charge.
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, message: "Use POST." });
  }

  let data;
  try {
    data = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, message: "Invalid request." });
  }

  const airport = RATES[data.airport];
  if (!airport) {
    return json(400, { ok: false, message: "Choose CLT, GSO, or RDU." });
  }

  const required = [
    "sourceId",
    "idempotencyKey",
    "pickupAt",
    "firstName",
    "lastName",
    "email",
    "phone",
    "pickup",
    "direction",
    "date",
    "time",
  ];
  for (const key of required) {
    if (!String(data[key] || "").trim()) {
      return json(400, { ok: false, message: "Please complete all trip details." });
    }
  }

  if (isPickupTooSoon(data.pickupAt)) {
    return json(400, {
      ok: false,
      message:
        "Online booking needs more than one hour. Text or call 980-457-5522.",
    });
  }

  const payChoice = data.payChoice === "full" ? "full" : "deposit";
  const depositCents = Math.round(airport.totalCents / 2);
  const paidCents = payChoice === "full" ? airport.totalCents : depositCents;
  const balanceCents = airport.totalCents - paidCents;
  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  const locationId = process.env.SQUARE_LOCATION_ID;
  const environment =
    process.env.SQUARE_ENVIRONMENT === "production" ? "production" : "sandbox";

  if (!accessToken || !locationId) {
    return json(500, {
      ok: false,
      message: "Square is not configured yet. Call 980-457-5522.",
    });
  }

  const code = bookingCode();
  const direction =
    data.direction === "from_airport" ? "From airport" : "To airport";
  const name = `${String(data.firstName).trim()} ${String(data.lastName).trim()}`;
  const payLabel =
    payChoice === "full"
      ? `AIRPORT PAID IN FULL ${money(paidCents)}`
      : `AIRPORT 50% DEPOSIT ${money(paidCents)} of ${money(airport.totalCents)}`;
  const note = [
    code,
    payLabel,
    airport.label,
    name,
    `${data.date} ${data.time}`,
    direction,
    `Pickup: ${data.pickup}`,
    data.flightNumber ? `Flight ${data.flightNumber}` : null,
    `${data.passengers || 1} pax`,
    data.phone,
  ]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 500);

  const paymentsUrl =
    environment === "production"
      ? "https://connect.squareup.com/v2/payments"
      : "https://connect.squareupsandbox.com/v2/payments";

  try {
    const response = await fetch(paymentsUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Square-Version": "2025-10-16",
      },
      body: JSON.stringify({
        idempotency_key: data.idempotencyKey,
        source_id: data.sourceId,
        autocomplete: true,
        location_id: locationId,
        amount_money: { amount: paidCents, currency: "USD" },
        buyer_email_address: String(data.email).trim(),
        reference_id: code,
        note,
      }),
    });

    const payload = await response.json();
    if (!response.ok || payload.errors?.length || !payload.payment?.id) {
      const detail =
        payload.errors?.[0]?.detail ||
        payload.errors?.[0]?.code ||
        "Square declined the card. Try again or call 980-457-5522.";
      return json(400, { ok: false, message: detail });
    }

    await emailOwner({
      _subject: `${payChoice === "full" ? "AIRPORT PAID IN FULL" : "AIRPORT DEPOSIT PAID"} — ${code} — ${money(paidCents)}`,
      type: payChoice === "full" ? "airport_paid_in_full" : "airport_deposit_paid",
      booking_code: code,
      square_payment_id: payload.payment.id,
      airport: airport.label,
      payment_type: payChoice === "full" ? "100% paid in full" : "50% deposit",
      amount_paid: money(paidCents),
      remaining_due: money(balanceCents),
      trip_total: money(airport.totalCents),
      name,
      email: data.email,
      phone: data.phone,
      pickup: data.pickup,
      direction,
      date: data.date,
      time: data.time,
      passengers: String(data.passengers || 1),
      flight_number: data.flightNumber || "",
      notes: data.notes || "",
      message:
        payChoice === "full"
          ? `A client paid IN FULL (${code}) for ${airport.label}. Charged ${money(paidCents)}. Nothing due to the chauffeur. Square payment ${payload.payment.id}.`
          : `A client paid a 50% airport deposit (${code}) for ${airport.label}. Charged ${money(paidCents)} of ${money(airport.totalCents)}. Balance ${money(balanceCents)} is due to the chauffeur. Square payment ${payload.payment.id}.`,
    });

    return json(200, {
      ok: true,
      bookingCode: code,
      paymentId: payload.payment.id,
      receiptUrl: payload.payment.receipt_url,
      paidCents,
      depositCents,
      balanceCents,
      totalCents: airport.totalCents,
      airportLabel: airport.label,
      payChoice,
    });
  } catch {
    return json(500, {
      ok: false,
      message: "Could not reach Square. Check your connection and try again.",
    });
  }
};
