import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

// Simple native response helper, completely independent of external dependencies
const jsonResponse = (data) => {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};

// ==========================================
// BASELINE BACKEND LOADER
// ==========================================
export const loader = async ({ request }) => {
  await authenticate.admin(request);
  
  return jsonResponse({
    status: "Database Synchronized Successfully",
    message: "Order Manager core baseline is live."
  });
};

// ==========================================
// BASELINE ZERO-DEPENDENCY FRONTEND UI
// ==========================================
export default function OrderDashboard() {
  const data = useLoaderData();

  return (
    <div style={{ 
      padding: "400px 40px", 
      fontFamily: "sans-serif", 
      textAlign: "center",
      backgroundColor: "#f4f6f8",
      minHeight: "100vh"
    }}>
      <div style={{
        background: "#ffffff",
        padding: "40px",
        borderRadius: "8px",
        boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
        maxWidth: "500px",
        margin: "0 auto"
      }}>
        <h1 style={{ color: "#008060", marginBottom: "16px", fontSize: "24px" }}>
          🚀 Order Manager Core Baseline Live
        </h1>
        <p style={{ color: "#6d7175", marginBottom: "24px", fontSize: "14px" }}>
          Framework routing validation complete. Ready to proceed with complex automated filtering logic.
        </p>
        <div style={{ 
          background: "#f1f2f4", 
          padding: "12px", 
          borderRadius: "4px", 
          fontSize: "12px",
          color: "#202223",
          fontWeight: "bold"
        }}>
          Status: {data.status}
        </div>
      </div>
    </div>
  );
}