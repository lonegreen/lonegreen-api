const PDFDocument = require("pdfkit");

function text(value, fallback = "-") {
  const clean = value === null || value === undefined ? "" : String(value);
  return clean.trim() || fallback;
}

function money(value) {
  const amount = Number(value || 0);
  return `$${amount.toFixed(2)}`;
}

function dateText(value) {
  if (!value) {
    return "-";
  }

  return String(value).split("T")[0] || "-";
}

function parseLineItems(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (!value) {
    return [];
  }

  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function collectPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

function addHeader(doc, title, company = {}) {
  doc.fontSize(20).fillColor("#173327").text(title, { align: "right" });
  doc.moveDown(0.25);

  doc.fontSize(14).fillColor("#1f5c3a").text(text(company.name, "LoneGreen"));
  doc.fontSize(9).fillColor("#4b6358");

  const lines = [
    company.phone,
    company.email,
    company.address
  ].filter(Boolean);

  for (const line of lines) {
    doc.text(text(line));
  }

  doc.moveDown(1.2);
  doc.strokeColor("#dbe7df").moveTo(50, doc.y).lineTo(562, doc.y).stroke();
  doc.moveDown(1);
}

function addKeyValue(doc, label, value) {
  doc.fontSize(9).fillColor("#6b8278").text(label.toUpperCase(), { continued: true });
  doc.fillColor("#173327").text(`  ${text(value)}`);
}

function addLineItems(doc, items, fallbackDescription, fallbackAmount) {
  doc.moveDown(0.8);
  doc.fontSize(12).fillColor("#173327").text("Line Items");
  doc.moveDown(0.35);

  const safeItems = items.length ? items : [{
    description: fallbackDescription || "Service",
    quantity: 1,
    price: Number(fallbackAmount || 0),
    amount: Number(fallbackAmount || 0)
  }];

  doc.fontSize(9).fillColor("#6b8278");
  doc.text("Description", 50, doc.y, { continued: true, width: 280 });
  doc.text("Qty", 330, doc.y, { continued: true, width: 60, align: "right" });
  doc.text("Price", 390, doc.y, { continued: true, width: 80, align: "right" });
  doc.text("Amount", 470, doc.y, { width: 90, align: "right" });
  doc.moveDown(0.2);
  doc.strokeColor("#dbe7df").moveTo(50, doc.y).lineTo(562, doc.y).stroke();
  doc.moveDown(0.35);

  for (const item of safeItems) {
    const quantity = Number(item.quantity || 1);
    const price = Number(item.price || 0);
    const amount = Number(item.amount !== undefined ? item.amount : quantity * price);

    doc.fontSize(10).fillColor("#173327");
    const y = doc.y;
    doc.text(text(item.description, "Service"), 50, y, { width: 270 });
    doc.text(String(quantity), 330, y, { width: 60, align: "right" });
    doc.text(money(price), 390, y, { width: 80, align: "right" });
    doc.text(money(amount), 470, y, { width: 90, align: "right" });
    doc.moveDown(0.7);
  }
}

async function generateInvoicePdf(invoice) {
  const doc = new PDFDocument({ margin: 50, size: "LETTER" });
  const company = {
    name: invoice.company_name,
    phone: invoice.company_phone,
    email: invoice.company_email,
    address: invoice.company_address
  };

  addHeader(doc, `Invoice ${text(invoice.invoice_number, `#${invoice.id}`)}`, company);

  doc.fontSize(12).fillColor("#173327").text("Bill To");
  doc.moveDown(0.3);
  addKeyValue(doc, "Client", invoice.client_name || invoice.customer_name);
  addKeyValue(doc, "Phone", invoice.client_phone);
  addKeyValue(doc, "Address", invoice.client_address);
  addKeyValue(doc, "Status", invoice.status);
  addKeyValue(doc, "Issued", dateText(invoice.issued_date));
  addKeyValue(doc, "Due", dateText(invoice.due_date));

  addLineItems(
    doc,
    parseLineItems(invoice.line_items),
    invoice.job_service || invoice.service || "Service",
    invoice.amount
  );

  doc.moveDown(0.8);
  doc.fontSize(12).fillColor("#173327").text("Summary", { align: "right" });
  doc.fontSize(10);
  doc.text(`Total: ${money(invoice.amount)}`, { align: "right" });
  doc.text(`Paid: ${money(invoice.paid_amount)}`, { align: "right" });
  doc.text(`Remaining: ${money(invoice.remaining_balance)}`, { align: "right" });

  if (invoice.notes) {
    doc.moveDown(1);
    doc.fontSize(12).fillColor("#173327").text("Notes");
    doc.fontSize(10).fillColor("#4b6358").text(text(invoice.notes));
  }

  return collectPdf(doc);
}

async function generateEstimatePdf(estimate, company = {}) {
  const doc = new PDFDocument({ margin: 50, size: "LETTER" });

  addHeader(doc, `Estimate #${text(estimate.id)}`, company);

  doc.fontSize(12).fillColor("#173327").text("Customer");
  doc.moveDown(0.3);
  addKeyValue(doc, "Name", estimate.customer_name || estimate.client_name);
  addKeyValue(doc, "Phone", estimate.phone);
  addKeyValue(doc, "Address", estimate.address);
  addKeyValue(doc, "Service", estimate.service);
  addKeyValue(doc, "Visit Date", dateText(estimate.visit_date));
  addKeyValue(doc, "Status", estimate.status);

  addLineItems(doc, [], estimate.service || "Service", estimate.quoted_price);

  doc.moveDown(0.8);
  doc.fontSize(12).fillColor("#173327").text(`Estimate Total: ${money(estimate.quoted_price)}`, {
    align: "right"
  });

  if (estimate.notes) {
    doc.moveDown(1);
    doc.fontSize(12).fillColor("#173327").text("Notes");
    doc.fontSize(10).fillColor("#4b6358").text(text(estimate.notes));
  }

  return collectPdf(doc);
}

module.exports = {
  generateInvoicePdf,
  generateEstimatePdf
};
