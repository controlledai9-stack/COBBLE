using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.ComponentModel;
using System.Threading;

internal static partial class ReviewGuard {
  static FileStream runtimeLease;
  const string ContainerName = "ControlledAI.Cobble.Review.Preflight.v2";
  [StructLayout(LayoutKind.Sequential)] struct Capabilities { public IntPtr Sid,List; public uint Count,Reserved; }
  [StructLayout(LayoutKind.Sequential)] struct SidAttributes { public IntPtr Sid; public uint Attributes; }
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr capabilities,uint count,out IntPtr sid);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name,out IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr info,uint length,out uint returned);
  [DllImport("FirewallAPI.dll")] static extern uint NetworkIsolationGetAppContainerConfig(out uint count,out IntPtr sids);
  [DllImport("kernel32.dll")] static extern IntPtr GetProcessHeap();
  [DllImport("kernel32.dll")] static extern bool HeapFree(IntPtr heap,uint flags,IntPtr address);

  static IntPtr ContainerSid() {
    IntPtr sid;int result=CreateAppContainerProfile(ContainerName,"Cobble review worker","Isolated local saved-source preflight",IntPtr.Zero,0,out sid);
    if(result==unchecked((int)0x800700B7)) result=DeriveAppContainerSidFromAppContainerName(ContainerName,out sid);
    if(result!=0) Marshal.ThrowExceptionForHR(result);
    return sid;
  }
  static void RefuseLoopbackExemption(IntPtr sid) {
    uint count;IntPtr list;uint error=NetworkIsolationGetAppContainerConfig(out count,out list);
    if(error!=0) throw new Win32Exception((int)error);
    try {
      SecurityIdentifier expected=new SecurityIdentifier(sid);
      int size=Marshal.SizeOf(typeof(SidAttributes));
      for(uint i=0;i<count;i++) {
        SidAttributes entry=(SidAttributes)Marshal.PtrToStructure(IntPtr.Add(list,checked((int)i*size)),typeof(SidAttributes));
        if(expected.Equals(new SecurityIdentifier(entry.Sid))) throw new InvalidOperationException("Container has a loopback exemption");
      }
    } finally {
      int size=Marshal.SizeOf(typeof(SidAttributes));
      for(uint i=0;i<count;i++) {
        SidAttributes entry=(SidAttributes)Marshal.PtrToStructure(IntPtr.Add(list,checked((int)i*size)),typeof(SidAttributes));
        if(entry.Sid!=IntPtr.Zero)HeapFree(GetProcessHeap(),0,entry.Sid);
      }
      if(list!=IntPtr.Zero)HeapFree(GetProcessHeap(),0,list);
    }
  }
  static void NoLink(string path) {
    if((File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0)throw new IOException("Reparse points are not permitted in runtime staging");
  }
  static void Protect(string path,SecurityIdentifier package,bool directory,bool readable) {
    FileSystemSecurity acl=directory?(FileSystemSecurity)new DirectorySecurity():new FileSecurity();
    acl.SetAccessRuleProtection(true,false);
    SecurityIdentifier user=WindowsIdentity.GetCurrent().User;
    acl.SetOwner(user);
    InheritanceFlags inherit=directory?InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit:InheritanceFlags.None;
    acl.AddAccessRule(new FileSystemAccessRule(user,FileSystemRights.FullControl,inherit,PropagationFlags.None,AccessControlType.Allow));
    acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-5-18"),FileSystemRights.FullControl,inherit,PropagationFlags.None,AccessControlType.Allow));
    // Suppress implicit owner WRITE_DAC; a contained token must not rewrite the cache ACL.
    acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-3-4"),FileSystemRights.ReadPermissions,inherit,PropagationFlags.None,AccessControlType.Allow));
    FileSystemRights forbidden=FileSystemRights.Write|FileSystemRights.Delete|FileSystemRights.DeleteSubdirectoriesAndFiles|FileSystemRights.ChangePermissions|FileSystemRights.TakeOwnership;
    acl.AddAccessRule(new FileSystemAccessRule(package,forbidden,inherit,PropagationFlags.None,AccessControlType.Deny));
    if(readable)acl.AddAccessRule(new FileSystemAccessRule(package,FileSystemRights.ReadAndExecute,inherit,PropagationFlags.None,AccessControlType.Allow));
    if(directory)Directory.SetAccessControl(path,(DirectorySecurity)acl);else File.SetAccessControl(path,(FileSecurity)acl);
  }
  static string DigestFile(string file) {
    NoLink(file);
    using(var hash=new SHA256Cng())using(var stream=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.Read))return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant();
  }
  static string StageRuntime(string exe,SecurityIdentifier sid,out string digest) {
    string source=Path.GetDirectoryName(exe);
    string[] allowed={"chrome_elf.dll","d3dcompiler_47.dll","ffmpeg.dll","libegl.dll","libglesv2.dll","vk_swiftshader.dll","vulkan-1.dll","dxcompiler.dll","dxil.dll","icudtl.dat","snapshot_blob.bin","v8_context_snapshot.bin","resources.pak","chrome_100_percent.pak","chrome_200_percent.pak","vcruntime140.dll","vcruntime140_1.dll","msvcp140.dll"};
    string[] files=Directory.GetFiles(source).Where(f=>String.Equals(f,exe,StringComparison.OrdinalIgnoreCase)||allowed.Contains(Path.GetFileName(f).ToLowerInvariant())).OrderBy(f=>Path.GetFileName(f),StringComparer.OrdinalIgnoreCase).ToArray();
    if(files.Length>64)throw new IOException("Runtime file count exceeded");
    StringBuilder identity=new StringBuilder();string[] hashes=new string[files.Length];long bytes=0;
    for(int i=0;i<files.Length;i++) {
      bytes+=new FileInfo(files[i]).Length;if(bytes>512L*1024*1024)throw new IOException("Runtime staging budget exceeded");
      hashes[i]=DigestFile(files[i]);identity.Append(Path.GetFileName(files[i])).Append(':').Append(hashes[i]).Append('\n');
    }
    using(var hash=new SHA256Cng())digest=BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(identity.ToString()))).Replace("-","").ToLowerInvariant();
    string local=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    if(String.IsNullOrEmpty(local))throw new IOException("Local app storage is unavailable");
    string root=Path.Combine(local,"Cobble","ReviewRuntimeV2");Directory.CreateDirectory(root);NoLink(root);Protect(root,sid,true,true);
    string cache=Path.Combine(root,digest);
    string mutexName="Local\\CobbleReviewCacheV2-"+WindowsIdentity.GetCurrent().User.Value;
    using(var mutex=new Mutex(false,mutexName)) {
      bool acquired=false;
      try {
        try { acquired=mutex.WaitOne(5000); } catch(AbandonedMutexException) { acquired=true; }
        if(!acquired)throw new IOException("Runtime cache is busy");
        var folders=Directory.GetDirectories(root).OrderBy(f=>Directory.GetLastWriteTimeUtc(f)).ToList();
        if(!Directory.Exists(cache)) {
          while(folders.Count>=2) {
            bool removed=false;
            for(int i=0;i<folders.Count;i++) {
              if(TryRemoveRuntime(folders[i])) { folders.RemoveAt(i);removed=true;break; }
            }
            if(!removed)throw new IOException("Runtime cache slots are in use");
          }
          Directory.CreateDirectory(cache);NoLink(cache);Protect(cache,sid,true,true);
          File.WriteAllText(Path.Combine(cache,".owner"),ContainerName);
        }
        NoLink(cache);Protect(cache,sid,true,true);
        if(File.ReadAllText(Path.Combine(cache,".owner"))!=ContainerName)throw new IOException("Unrecognized runtime cache");
        string lease=Path.Combine(cache,".lease");
        if(!File.Exists(lease))File.WriteAllText(lease,"");
        NoLink(lease);Protect(lease,sid,false,true);
        for(int i=0;i<files.Length;i++) {
          string target=Path.Combine(cache,Path.GetFileName(files[i]));
          if(!File.Exists(target)||DigestFile(target)!=hashes[i]) {
            if(File.Exists(target))File.SetAttributes(target,File.GetAttributes(target)&~FileAttributes.ReadOnly);
            File.Copy(files[i],target,true);
            if(DigestFile(target)!=hashes[i])throw new IOException("Staged runtime hash mismatch");
          }
          Protect(target,sid,false,true);
        }
        Protect(Path.Combine(cache,".owner"),sid,false,true);
        runtimeLease=new FileStream(lease,FileMode.Open,FileAccess.Read,FileShare.Read);
        Directory.SetLastWriteTimeUtc(cache,DateTime.UtcNow);
      } finally { if(acquired)mutex.ReleaseMutex(); }
    }
    return Path.Combine(cache,Path.GetFileName(exe));
  }
  static bool TryRemoveRuntime(string folder) {
    try {
      NoLink(folder);
      string name=Path.GetFileName(folder);
      if(name.Length!=64 || name.Any(c=>!((c>='0'&&c<='9')||(c>='a'&&c<='f'))))return false;
      string marker=Path.Combine(folder,".owner");NoLink(marker);
      if(new FileInfo(marker).Length>128 || File.ReadAllText(marker)!=ContainerName || Directory.GetDirectories(folder).Length!=0)return false;
      string lease=Path.Combine(folder,".lease");
      if(File.Exists(lease))using(var exclusive=new FileStream(lease,FileMode.Open,FileAccess.ReadWrite,FileShare.None)) {}
      string[] entries=Directory.GetFiles(folder);
      foreach(string file in entries)NoLink(file);
      // Only this component's bounded, flat, marker-owned cache directories are removed.
      foreach(string file in entries) { File.SetAttributes(file,File.GetAttributes(file)&~FileAttributes.ReadOnly);File.Delete(file); }
      Directory.Delete(folder,false);return true;
    } catch(IOException) { return false; } catch(UnauthorizedAccessException) { return false; }
  }
  static string StageWorker(string original,string report,SecurityIdentifier sid) {
    if(new FileInfo(original).Length>1000000)throw new IOException("Worker staging budget exceeded");
    string root=Path.GetDirectoryName(report);
    string folder=Path.Combine(root,"worker");Directory.CreateDirectory(folder);NoLink(folder);Protect(folder,sid,true,true);
    string staged=Path.Combine(folder,"worker.cjs");File.Copy(original,staged,true);Protect(staged,sid,false,true);
    if(DigestFile(original)!=DigestFile(staged))throw new IOException("Staged worker mismatch");
    return staged;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
  static string PrepareControl(string requested,SecurityIdentifier sid,out IntPtr directoryLock,out FileStream reportStream) {
    string root=requested+".private";
    if(Directory.Exists(root)||File.Exists(root))throw new IOException("Control folder already exists");
    Directory.CreateDirectory(root);NoLink(root);Protect(root,sid,true,false);
    directoryLock=CreateFile(root,0x80,3,IntPtr.Zero,3,0x02000000,IntPtr.Zero);
    Check(directoryLock!=new IntPtr(-1)&&directoryLock!=IntPtr.Zero);
    reportStream=new FileStream(Path.Combine(root,"usage.json"),FileMode.CreateNew,FileAccess.Write,FileShare.None);
    return Path.Combine(root,"usage.json");
  }
  static IntPtr CleanEnvironment() {
    string[] names={"SystemRoot","WINDIR","LOCALAPPDATA","USERPROFILE","TEMP","TMP","UV_THREADPOOL_SIZE","ELECTRON_RUN_AS_NODE"};
    var values=names.Select(n=>new {Name=n,Value=Environment.GetEnvironmentVariable(n)}).Where(v=>v.Value!=null).OrderBy(v=>v.Name,StringComparer.OrdinalIgnoreCase).Select(v=>v.Name+"="+v.Value);
    return Marshal.StringToHGlobalUni(String.Join("\0",values.ToArray())+"\0\0");
  }
  static void VerifyContainer(IntPtr process,IntPtr sid) {
    IntPtr token=IntPtr.Zero,buffer=IntPtr.Zero;
    try {
      Check(OpenProcessToken(process,8,out token));uint length;
      buffer=Marshal.AllocHGlobal(4);Check(GetTokenInformation(token,29,buffer,4,out length));Check(Marshal.ReadInt32(buffer)==1);Marshal.FreeHGlobal(buffer);buffer=IntPtr.Zero;
      GetTokenInformation(token,30,IntPtr.Zero,0,out length);if(length<4||length>64000)throw new InvalidOperationException("Invalid token capability size");
      buffer=Marshal.AllocHGlobal((int)length);Check(GetTokenInformation(token,30,buffer,length,out length));Check(Marshal.ReadInt32(buffer)==0);Marshal.FreeHGlobal(buffer);buffer=IntPtr.Zero;
      GetTokenInformation(token,31,IntPtr.Zero,0,out length);if(length<IntPtr.Size||length>64000)throw new InvalidOperationException("Invalid token container SID size");
      buffer=Marshal.AllocHGlobal((int)length);Check(GetTokenInformation(token,31,buffer,length,out length));Check(new SecurityIdentifier(Marshal.ReadIntPtr(buffer)).Equals(new SecurityIdentifier(sid)));
    } finally {if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer);Close(ref token);}
  }
}
