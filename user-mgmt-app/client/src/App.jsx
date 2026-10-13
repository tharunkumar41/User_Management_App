import { Routes, Route, Navigate } from 'react-router-dom';
import { ProtectedRoute, GuestRoute, AdminRoute } from './components/ProtectedRoute';
import Layout from './components/Layout';
import Register from './pages/Register';
import Login from './pages/Login';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import VerifyEmail from './pages/VerifyEmail';
import Home from './pages/Home';
import Profile from './pages/Profile';
import EditProfile from './pages/EditProfile';
import ChangePassword from './pages/ChangePassword';
import Users from './pages/Users';
import UserForm from './pages/UserForm';
import Chat from './pages/Chat';
import Vision from './pages/Vision';
import VisitingCard from './pages/vision/VisitingCard';
import FaceDetection from './pages/vision/FaceDetection';
import ObjectDetection from './pages/vision/ObjectDetection';
import VehicleIdentification from './pages/vision/VehicleIdentification';
import Mock from './pages/Mock';
import PyqUpload from './pages/mock/PyqUpload';
import TextbookUpload from './pages/mock/TextbookUpload';
import ConductTest from './pages/mock/ConductTest';

export default function App() {
  return (
    <Routes>
      <Route element={<GuestRoute />}>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
      </Route>

      {/* Reachable whether or not you're signed in (the link comes from an email) */}
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<Layout />}>
          <Route path="/" element={<Home />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/profile/edit" element={<EditProfile />} />
          <Route path="/change-password" element={<ChangePassword />} />
          <Route path="/chat/:conversationId?" element={<Chat />} />
          <Route path="/vision" element={<Vision />}>
            <Route index element={<VisitingCard />} />
            <Route path="visiting-card" element={<VisitingCard />} />
            <Route path="face-detection" element={<FaceDetection />} />
            <Route path="object-detection" element={<ObjectDetection />} />
            <Route path="vehicle" element={<VehicleIdentification />} />
          </Route>
          <Route path="/mock" element={<Mock />}>
            <Route index element={<PyqUpload />} />
            <Route path="pyq" element={<PyqUpload />} />
            <Route path="textbook" element={<TextbookUpload />} />
            <Route path="tests" element={<ConductTest />} />
          </Route>
          <Route element={<AdminRoute />}>
            <Route path="/users" element={<Users />} />
            <Route path="/users/new" element={<UserForm />} />
            <Route path="/users/:id/edit" element={<UserForm />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
