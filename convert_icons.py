import os
import sys
import urllib.request
import zipfile
import shutil

# Paths relative to the script location
script_dir = os.path.dirname(os.path.abspath(__file__))
icons_dir = os.path.join(script_dir, "repolens", "extension", "icons")

def setup_windows_cairo():
    if os.name != 'nt':
        return

    # Check if we already have the DLL path configured or cached
    cache_dir = os.path.join(script_dir, ".cairo_cache")
    dll_dir = None

    # Try to find cairo.dll in cache if it exists
    if os.path.exists(cache_dir):
        for root, dirs, files in os.walk(cache_dir):
            for file in files:
                if file.lower() in ["cairo.dll", "libcairo-2.dll"]:
                    # We want 64-bit DLL if Python is 64-bit
                    is_64bit = sys.maxsize > 2**31
                    parent_dir = os.path.basename(root)
                    if (is_64bit and parent_dir == 'x64') or (not is_64bit and parent_dir == 'x86') or (parent_dir not in ['x64', 'x86']):
                        dll_dir = root
                        break
            if dll_dir:
                break

    # If not found, download and extract
    if not dll_dir:
        print("Cairo DLLs not found. Downloading precompiled Cairo binaries for Windows...")
        zip_url = "https://github.com/preshing/cairo-windows/releases/download/1.17.2/cairo-windows-1.17.2.zip"
        zip_path = os.path.join(script_dir, "cairo-windows.zip")
        
        try:
            req = urllib.request.Request(zip_url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req) as response, open(zip_path, 'wb') as out_file:
                shutil.copyfileobj(response, out_file)
            
            print("Extracting Cairo binaries...")
            os.makedirs(cache_dir, exist_ok=True)
            with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                zip_ref.extractall(cache_dir)
            
            # Clean up zip
            os.remove(zip_path)
            
            # Find the correct DLL dir
            is_64bit = sys.maxsize > 2**31
            target_sub = 'x64' if is_64bit else 'x86'
            for root, dirs, files in os.walk(cache_dir):
                for file in files:
                    if file.lower() in ["cairo.dll", "libcairo-2.dll"]:
                        if os.path.basename(root) == target_sub:
                            dll_dir = root
                            break
            if not dll_dir:
                # Fallback to any directory containing cairo.dll
                for root, dirs, files in os.walk(cache_dir):
                    for file in files:
                        if file.lower() in ["cairo.dll", "libcairo-2.dll"]:
                            dll_dir = root
                            break
        except Exception as e:
            print(f"Failed to download/extract Cairo DLLs: {e}")
            return

    if dll_dir:
        print(f"Adding Cairo DLL directory to path: {dll_dir}")
        # Add to DLL search path for Python 3.8+
        if hasattr(os, "add_dll_directory"):
            os.add_dll_directory(dll_dir)
        # Also add to PATH env var for older Python versions / general fallback
        os.environ["PATH"] = dll_dir + os.path.pathsep + os.environ.get("PATH", "")

# Run Windows setup before importing cairosvg
setup_windows_cairo()

try:
    import cairosvg
except ImportError as e:
    print(f"ImportError: {e}")
    print("Error: Could not import 'cairosvg'. Please ensure it's installed: pip install cairosvg")
    sys.exit(1)
except OSError as e:
    print(f"OSError: {e}")
    print("Error: Cairo shared library not found even after setup. You may need to install the GTK3 runtime manually.")
    sys.exit(1)

sizes = [16, 32, 48, 128]

for size in sizes:
    svg_path = os.path.join(icons_dir, f"icon{size}.svg")
    png_path = os.path.join(icons_dir, f"icon{size}.png")
    
    if not os.path.exists(svg_path):
        print(f"Error: SVG file not found at {svg_path}")
        continue
        
    print(f"Converting icon{size}.svg -> icon{size}.png...")
    try:
        cairosvg.svg2png(url=svg_path, write_to=png_path)
    except Exception as e:
        print(f"Failed to convert icon{size}.svg: {e}")

print("All done!")
