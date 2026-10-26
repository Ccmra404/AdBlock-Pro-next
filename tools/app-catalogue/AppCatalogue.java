import java.lang.reflect.Method;
import java.util.List;

/** Read-only package labels for WebUI hosts that only expose a shell bridge. */
public final class AppCatalogue {
    private static String quote(String value) {
        StringBuilder out = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '"' || c == '\\') out.append('\\').append(c);
            else if (c < 32) out.append(String.format("\\u%04x", (int) c));
            else out.append(c);
        }
        return out.append('"').toString();
    }

    public static void main(String[] args) {
        try {
            Class.forName("android.os.Looper").getMethod("prepareMainLooper").invoke(null);
            Class<?> activityThread = Class.forName("android.app.ActivityThread");
            Object thread = activityThread.getMethod("systemMain").invoke(null);
            Object context = activityThread.getMethod("getSystemContext").invoke(thread);
            Object pm = Class.forName("android.content.Context").getMethod("getPackageManager").invoke(context);
            Class<?> manager = Class.forName("android.content.pm.PackageManager");
            Class<?> appInfo = Class.forName("android.content.pm.ApplicationInfo");
            Method labelMethod = manager.getMethod("getApplicationLabel", appInfo);
            List<?> apps = (List<?>) manager.getMethod("getInstalledApplications", int.class).invoke(pm, 0);
            StringBuilder json = new StringBuilder("[");
            boolean first = true;
            for (Object app : apps) {
                if ((appInfo.getField("flags").getInt(app) & 1) != 0) continue;
                String name = (String) appInfo.getField("packageName").get(app);
                String label = name;
                try {
                    Object loaded = labelMethod.invoke(pm, app);
                    if (loaded != null && !loaded.toString().trim().isEmpty()) label = loaded.toString().substring(0, Math.min(255, loaded.toString().length()));
                } catch (ReflectiveOperationException ignored) { }
                if (!first) json.append(',');
                first = false;
                json.append("{\"packageName\":").append(quote(name));
                json.append(",\"appLabel\":").append(quote(label)).append('}');
            }
            System.out.println(json.append(']'));
        } catch (Exception e) {
            System.err.println("Cannot read application labels: " + e.getClass().getSimpleName());
            System.exit(1);
        }
    }
}
