import svgwrite
import math

def interpolate_color(start_color, end_color, t):
    return tuple(
        int(start_color[i] + (end_color[i] - start_color[i]) * t)
        for i in range(3)
    )

def rotate_point(cx, cy, px, py, angle_rad):
    """Rotate (px, py) around (cx, cy) by angle_rad."""
    s = math.sin(angle_rad)
    c = math.cos(angle_rad)

    px -= cx
    py -= cy

    xnew = px * c - py * s
    ynew = px * s + py * c

    return (xnew + cx, ynew + cy)

def create_spaced_rotated_lines_svg(
    filename='spaced_rotated_lines.svg',
    canvas_size=(3200, 1800),
    num_lines=40,
    rotation_step_deg=1,
    line_length=5000,
    base_pivot=(900, 900),
    spacing=(25, 0),  # (x_spacing, y_spacing) between each base
    centered_lines=True,
    start_color=(230, 18, 100, 1.0),
    end_color=(255, 255, 255, 0.5),
    stroke_width=1
):
    dwg = svgwrite.Drawing(filename, size=canvas_size)
    half_len = line_length / 2

    for i in range(num_lines):
        angle_deg = i * rotation_step_deg
        angle_rad = math.radians(angle_deg)

        # Offset pivot by spacing * index
        cx = base_pivot[0] + i * spacing[0]
        cy = base_pivot[1] + i * spacing[1]

        if centered_lines:
            # Symmetrical line around center
            p1 = rotate_point(cx, cy, cx - half_len, cy, angle_rad)
            p2 = rotate_point(cx, cy, cx + half_len, cy, angle_rad)
        else:
            # Line from pivot out
            p1 = (cx, cy)
            p2 = rotate_point(cx, cy, cx + line_length, cy, angle_rad)

        t = i / (num_lines - 1)
        r, g, b = interpolate_color(start_color, end_color, t)

        dwg.add(dwg.line(
            start=p1,
            end=p2,
            stroke=svgwrite.rgb(r, g, b),
            stroke_width=stroke_width
        ))

    dwg.save()
    print(f"SVG saved as '{filename}'")

# Example run
if __name__ == "__main__":
    create_spaced_rotated_lines_svg()