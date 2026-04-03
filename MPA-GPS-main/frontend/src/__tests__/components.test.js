// src/__tests__/components.test.js
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import VesselPanel from "../components/VesselPanel";
import SpeedLegend from "../components/SpeedLegend";
import ErrorBanner from "../components/ErrorBanner";

const VESSELS = [
  {
    vessel_name: "MV ALPHA",
    imo_number: 1111111,
    speed: 12,
    vessel_type: "Cargo",
    latitude_degrees: 1.3,
    longitude_degrees: 103.8,
  },
  {
    vessel_name: "MV BETA",
    imo_number: 2222222,
    speed: 0,
    vessel_type: "Tanker",
    latitude_degrees: 1.4,
    longitude_degrees: 103.9,
  },
  {
    vessel_name: "MV GAMMA",
    imo_number: 3333333,
    speed: 5,
    vessel_type: "Fishing",
    latitude_degrees: 1.5,
    longitude_degrees: 104.0,
  },
];

// ── VesselPanel ─────────────────────────────────────────────────
describe("VesselPanel", () => {
  test("renders vessel names", () => {
    render(
      <VesselPanel
        vessels={VESSELS}
        selectedId={null}
        onSelect={() => {}}
        loading={false}
      />,
    );
    expect(screen.getByText("MV ALPHA")).toBeInTheDocument();
    expect(screen.getByText("MV BETA")).toBeInTheDocument();
    expect(screen.getByText("MV GAMMA")).toBeInTheDocument();
  });

  test("shows vessel count", () => {
    render(
      <VesselPanel
        vessels={VESSELS}
        selectedId={null}
        onSelect={() => {}}
        loading={false}
      />,
    );
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  test("calls onSelect when vessel clicked", () => {
    const onSelect = jest.fn();
    render(
      <VesselPanel
        vessels={VESSELS}
        selectedId={null}
        onSelect={onSelect}
        loading={false}
      />,
    );
    fireEvent.click(screen.getByText("MV ALPHA"));
    expect(onSelect).toHaveBeenCalledWith(VESSELS[0]);
  });

  test("highlights selected vessel", () => {
    const { container } = render(
      <VesselPanel
        vessels={VESSELS}
        selectedId={1111111}
        onSelect={() => {}}
        loading={false}
      />,
    );
    const selected = container.querySelector(".vp-item.selected");
    expect(selected).toBeInTheDocument();
  });

  test("shows empty state when no vessels", () => {
    render(
      <VesselPanel
        vessels={[]}
        selectedId={null}
        onSelect={() => {}}
        loading={false}
      />,
    );
    expect(screen.getByText(/no vessels found/i)).toBeInTheDocument();
  });

  test("shows loading spinner", () => {
    const { container } = render(
      <VesselPanel
        vessels={[]}
        selectedId={null}
        onSelect={() => {}}
        loading={true}
      />,
    );
    expect(container.querySelector(".vp-spinner")).toBeInTheDocument();
  });
});

// ── SpeedLegend ─────────────────────────────────────────────────
describe("SpeedLegend", () => {
  test("renders all speed categories", () => {
    render(<SpeedLegend />);
    // SpeedLegend starts collapsed, click to expand
    const toggle = screen.getByRole("button");
    fireEvent.click(toggle);
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    expect(screen.getByText("Slow")).toBeInTheDocument();
    expect(screen.getByText("Medium")).toBeInTheDocument();
    expect(screen.getByText("Fast")).toBeInTheDocument();
  });

  test("renders speed ranges", () => {
    render(<SpeedLegend />);
    const toggle = screen.getByRole("button");
    fireEvent.click(toggle);
    expect(screen.getByText("≤ 0.5 kn")).toBeInTheDocument();
    expect(screen.getByText("≥ 12 kn")).toBeInTheDocument();
  });
});

// ── ErrorBanner ─────────────────────────────────────────────────
describe("ErrorBanner", () => {
  test("renders nothing when no message", () => {
    const { container } = render(<ErrorBanner message={null} />);
    expect(container.firstChild).toBeNull();
  });

  test("renders error message", () => {
    render(<ErrorBanner message="Connection failed" />);
    expect(screen.getByText(/connection failed/i)).toBeInTheDocument();
  });

  test("calls onRetry when retry button clicked", () => {
    const onRetry = jest.fn();
    render(<ErrorBanner message="Error" onRetry={onRetry} />);
    fireEvent.click(screen.getByText(/retry/i));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});