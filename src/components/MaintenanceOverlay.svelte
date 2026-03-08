<script>
  import { onMount } from "svelte";

  // Maintenance mode state - controlled via localStorage for easy toggling
  // Set 'maintenanceMode' in localStorage to 'true' to enable
  let isMaintenanceMode = false;

  onMount(() => {
    // Check localStorage on mount
    const stored = localStorage.getItem("maintenanceMode");
    isMaintenanceMode = stored === "true";
    isMaintenanceMode = false;

    // Expose toggle function to window for easy console access
    window.toggleMaintenanceMode = () => {
      isMaintenanceMode = !isMaintenanceMode;
      localStorage.setItem("maintenanceMode", isMaintenanceMode.toString());
      console.log(`Maintenance mode: ${isMaintenanceMode ? "ON" : "OFF"}`);
      return isMaintenanceMode;
    };

    console.log(
      "💡 Tip: Run `toggleMaintenanceMode()` in console to toggle overlay",
    );
  });
</script>

{#if isMaintenanceMode}
  <div class="maintenance-overlay">
    <div class="maintenance-content">
      <div class="icon">
        <svg
          width="64"
          height="64"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            d="M12 8V12"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <circle cx="12" cy="16" r="1" fill="currentColor" />
        </svg>
      </div>
      <h1>Under Maintenance</h1>
      <p>We'll be back shortly. Thank you for your patience.</p>
    </div>
  </div>
{/if}

<style>
  .maintenance-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.95);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 9999;
  }

  .maintenance-content {
    text-align: center;
    color: white;
    animation: fadeIn 0.3s ease-out;
  }

  .icon {
    margin-bottom: 24px;
    opacity: 0.9;
  }

  h1 {
    font-size: 2rem;
    font-weight: 600;
    margin: 0 0 12px 0;
    letter-spacing: -0.02em;
  }

  p {
    font-size: 1.1rem;
    color: rgba(255, 255, 255, 0.7);
    margin: 0;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
